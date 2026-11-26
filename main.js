const { Plugin, PluginSettingTab, Setting, Notice, Modal, FuzzySuggestModal, TFolder } = require('obsidian');

const DEFAULT_SETTINGS = {
  convertOnPaste: true,
  showNotices: true,
  backupBatch: true,
};

// Fenced code blocks, tilde fences, and inline code are captured so they are left untouched.
// Fences must start at the beginning of a line. Obsidian comments (%% ... %%) are skipped too.
const CODE = /(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~|``[^`\n]*``|`[^`\n]+`|%%[\s\S]*?%%)/gm;

// YAML frontmatter at the very start of a note is skipped.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

// LaTeX spacing after a line break, such as \\[6pt] or \\[2pt], is not display math.
const SPACING = String.raw`\s*\d+(?:\.\d+)?\s*(?:pt|em|ex|mm|cm|in|bp|pc|dd|cc|sp|mu)\s*\]`;

// One pass over four forms, in this order:
//  1. JSON-escaped display  \\[ ... \\]   (both delimiters doubled)
//  2. standard display       \[ ... \]
//  3. JSON-escaped inline   \\( ... \\)
//  4. standard inline        \( ... \)
// A delimiter preceded by a backslash is not an opener or closer.
// Display bodies may span lines. Inline bodies stay on one line.
const MATH = new RegExp([
  String.raw`(?<!\\)\\\\\[(?!${SPACING})((?:(?!\\\\\[)[\s\S])*?)\\\\\]`,
  String.raw`(?<!\\)\\\[(?!${SPACING})([\s\S]*?)(?<!\\)\\\]`,
  String.raw`(?<!\\)\\\\\(([^\n]*?)\\\\\)`,
  String.raw`(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)`,
].join('|'), 'g');

// Turns doubled command backslashes (\\frac, \\cdot) into single ones.
// A line break (\\) followed by a space or a number is left alone.
function fixBody(b) {
  return b.trim().replace(/\\\\(?=[a-zA-Z{}])/g, '\\');
}

function convertText(s) {
  let n = 0;
  const out = s.replace(MATH, (_, d1, s1, d2, s2) => {
    n++;
    const block = d1 ?? s1;
    if (block !== undefined) return `$$\n${fixBody(block)}\n$$`;
    return `$${fixBody(d2 ?? s2)}$`;
  });
  return [out, n];
}

function convert(md) {
  let count = 0;
  let head = '';
  const fm = md.match(FRONTMATTER);
  if (fm) {
    head = fm[0];
    md = md.slice(head.length);
  }
  const body = md.split(CODE).map((part, i) => {
    if (i % 2 === 1) return part; // code, comment, or frontmatter segment: keep as is
    const [s, n] = convertText(part);
    count += n;
    return s;
  }).join('');
  return { out: head + body, count };
}

// Pasted text often has a blank line between list items (bullets or numbers), which makes the
// list loose. Normalizes line endings and removes blank lines that sit between two list items.
const LIST_BLANKS = /^([ \t]*(?:[-*+]|\d+[.)])[ \t][^\n]*)\n(?:[ \t]*\n)+(?=[ \t]*(?:[-*+]|\d+[.)])[ \t])/gm;

function tidyPastedLists(text) {
  return text.replace(/\r\n?/g, '\n').replace(LIST_BLANKS, '$1\n');
}

// Replaces only the changed middle of the note, so the cursor and scroll position survive
// and the whole conversion is one undo step.
function applyChange(editor, oldText, newText) {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  editor.transaction({
    changes: [{
      from: editor.offsetToPos(start),
      to: editor.offsetToPos(oldEnd),
      text: newText.slice(start, newEnd),
    }],
  });
}

// All non-empty selections (multi-cursor aware), ordered by position.
function selectedRanges(editor) {
  return editor.listSelections()
    .map(({ anchor, head }) => {
      const a = editor.posToOffset(anchor);
      const h = editor.posToOffset(head);
      return a <= h
        ? { from: anchor, to: head, start: a, end: h }
        : { from: head, to: anchor, start: h, end: a };
    })
    .filter((r) => r.start !== r.end)
    .sort((x, y) => x.start - y.start);
}

// Lets the user pick any folder in the vault (including the vault root).
class FolderPicker extends FuzzySuggestModal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder('Choose a folder to convert');
  }

  getItems() {
    const folders = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);
    const root = this.app.vault.getRoot();
    if (!folders.includes(root)) folders.unshift(root);
    return folders;
  }

  getItemText(folder) {
    return folder.isRoot() ? '/ (whole vault)' : folder.path;
  }

  onChooseItem(folder) {
    this.onPick(folder);
  }
}

// Shows a summary and asks the user to confirm before any file is written.
class ConfirmModal extends Modal {
  constructor(app, { title, message, onConfirm, confirmText = 'Convert' }) {
    super(app);
    this.title = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmText = confirmText;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.message });
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const ok = row.createEl('button', { text: this.confirmText, cls: 'mod-cta' });
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class LatexDelimiterConvert extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'convert-note',
      name: 'Convert \\( \\) and \\[ \\] in current note',
      editorCallback: (editor) => {
        const text = editor.getValue();
        const { out, count } = convert(text);
        if (out !== text) applyChange(editor, text, out);
        this.report(count);
      },
    });

    this.addCommand({
      id: 'convert-selection',
      name: 'Convert \\( \\) and \\[ \\] in selection',
      editorCheckCallback: (checking, editor) => {
        const ranges = selectedRanges(editor);
        if (!ranges.length) return false;
        if (!checking) {
          let count = 0;
          const changes = ranges.map(({ from, to }) => {
            const r = convert(editor.getRange(from, to));
            count += r.count;
            return { from, to, text: r.out };
          });
          if (count) editor.transaction({ changes });
          this.report(count);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'batch-convert-folder',
      name: 'Batch convert folder (this folder only)',
      callback: () => new FolderPicker(this.app, (folder) => this.previewBatch(folder, false)).open(),
    });

    this.addCommand({
      id: 'batch-convert-folder-recursive',
      name: 'Batch convert folder (including subfolders)',
      callback: () => new FolderPicker(this.app, (folder) => this.previewBatch(folder, true)).open(),
    });

    this.addCommand({
      id: 'clear-batch-backups',
      name: 'Clear batch conversion backups',
      callback: () => this.clearBackups(),
    });

    // Converts pasted text when the option is enabled. Zero matches leave the paste untouched and silent.
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor) => {
        if (!this.settings.convertOnPaste || evt.defaultPrevented) return;
        const pasted = evt.clipboardData?.getData('text/plain');
        if (!pasted) return;
        const tidied = tidyPastedLists(pasted);
        const { out, count } = convert(tidied);
        if (!count && tidied === pasted) return; // nothing to change: let Obsidian paste as usual
        evt.preventDefault();
        editor.replaceSelection(out);
        if (count) this.report(count);
      })
    );

    this.addSettingTab(new LatexDelimiterSettingTab(this.app, this));
  }

  // Markdown files directly in the folder, or also in its subfolders.
  collectFiles(folder, recursive) {
    const prefix = folder.isRoot() ? '' : `${folder.path}/`;
    return this.app.vault.getMarkdownFiles().filter((f) => (
      recursive ? f.path.startsWith(prefix) : f.parent === folder
    ));
  }

  // Counts what would change, then asks for confirmation. Nothing is written here.
  async previewBatch(folder, recursive) {
    const files = this.collectFiles(folder, recursive);
    if (!files.length) {
      new Notice('No .md files found in that folder.');
      return;
    }

    let changing = 0;
    let formulas = 0;
    for (const file of files) {
      const text = await this.app.vault.read(file);
      const { out, count } = convert(text);
      if (out !== text) {
        changing++;
        formulas += count;
      }
    }

    if (!changing) {
      new Notice(`Checked ${files.length} file(s): no \\( \\) or \\[ \\] found.`);
      return;
    }

    const backupText = this.settings.backupBatch
      ? 'Originals are backed up first.'
      : 'Backups are off. This cannot be undone.';
    new ConfirmModal(this.app, {
      title: 'Batch convert',
      message: `${changing} of ${files.length} file(s) will change, with ${formulas} formula(s) converted. ${backupText}`,
      onConfirm: () => this.applyBatch(files),
    }).open();
  }

  // Re-reads each file before changing it, so edits made since the preview are kept.
  async applyBatch(files) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = `${this.manifest.dir}/backups/${stamp}`;
    let changed = 0;
    let formulas = 0;
    let failed = 0;

    for (const file of files) {
      try {
        const text = await this.app.vault.read(file);
        const { out, count } = convert(text);
        if (out === text) continue;

        if (this.settings.backupBatch) {
          const dest = `${backupRoot}/${file.path}`;
          await this.ensureDir(dest.slice(0, dest.lastIndexOf('/')));
          await this.app.vault.adapter.write(dest, text);
        }

        await this.app.vault.modify(file, out);
        changed++;
        formulas += count;
      } catch (e) {
        failed++;
        console.error('AI Math Paste: failed on', file.path, e);
      }
    }

    let msg = `Converted ${changed} file(s), ${formulas} formula(s).`;
    if (failed) msg += ` ${failed} failed (see console).`;
    if (this.settings.backupBatch && changed) msg += ` Originals saved in ${backupRoot}.`;
    new Notice(msg, 10000);
  }

  async ensureDir(dir) {
    const adapter = this.app.vault.adapter;
    let cur = '';
    for (const part of dir.split('/')) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
  }

  backupsDir() {
    return `${this.manifest.dir}/backups`;
  }

  // Asks first, then deletes every backup run. Only the plugin's own backups folder is touched.
  async clearBackups() {
    const dir = this.backupsDir();
    const adapter = this.app.vault.adapter;
    const runs = (await adapter.exists(dir)) ? (await adapter.list(dir)).folders : [];
    if (!runs.length) {
      new Notice('No batch backups to clear.');
      return;
    }
    new ConfirmModal(this.app, {
      title: 'Clear batch backups',
      message: `Delete ${runs.length} backup run(s) in ${dir}? This cannot be undone.`,
      confirmText: 'Delete',
      onConfirm: () => this.deleteBackups(runs.length),
    }).open();
  }

  async deleteBackups(runCount) {
    await this.app.vault.adapter.rmdir(this.backupsDir(), true);
    new Notice(`Deleted ${runCount} backup run(s).`);
  }

  report(count) {
    if (!this.settings.showNotices) return;
    new Notice(count
      ? `${count} formula${count > 1 ? 's' : ''} converted`
      : 'No \\( \\) or \\[ \\] found');
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class LatexDelimiterSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('AI Math Paste').setHeading();

    new Setting(containerEl)
      .setName('Convert on paste')
      .setDesc('When pasting text that contains \\( \\) or \\[ \\], convert it to $ and $$ automatically. Formatting from rich-text sources is not kept.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.convertOnPaste)
        .onChange(async (value) => {
          this.plugin.settings.convertOnPaste = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show notices')
      .setDesc('Show a message with the number of formulas converted.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.showNotices)
        .onChange(async (value) => {
          this.plugin.settings.showNotices = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Clear batch backups')
      .setDesc('Delete all saved backups from batch conversion. Asks for confirmation first.')
      .addButton((b) => b
        .setButtonText('Clear backups')
        .setWarning()
        .onClick(() => this.plugin.clearBackups()));

    new Setting(containerEl)
      .setName('Back up files before batch conversion')
      .setDesc('Save a copy of each changed file in the plugin folder (.obsidian/plugins/ai-math-paste/backups) before batch conversion writes it.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.backupBatch)
        .onChange(async (value) => {
          this.plugin.settings.backupBatch = value;
          await this.plugin.saveSettings();
        }));
  }
}
