# AI Math Paste

An Obsidian plugin that converts LaTeX math from AI chatbots into Obsidian math syntax.

Chatbots often write math with `\( … \)` for inline formulas and `\[ … \]` for display formulas. Obsidian uses `$ … $` and `$$ … $$`. AI Math Paste converts one into the other, in a single note, a selection, on paste, or across a whole folder.

## Example

Before:

```
The energy is \(E = mc^2\), and the integral is
\[ \int_0^1 x^2 \, dx \]
```

After:

```
The energy is $E = mc^2$, and the integral is
$$
\int_0^1 x^2 \, dx
$$
```

## Features

- **Current note:** converts the whole active note as one undo step. The cursor stays where it was.
- **Selection:** converts every selected range, including multiple cursors.
- **Paste:** optionally converts pasted text that contains `\( \)` or `\[ \]`.
- **Batch folder conversion:** converts every `.md` file in a folder you choose, either just that folder or the folder and all its subfolders. It shows how many files will change and asks for confirmation before writing anything.
- **Backups:** before a batch conversion, saves the original of each changed file.

Code blocks, inline code, YAML frontmatter, and Obsidian comments (`%% … %%`) are left unchanged.

## Commands

Open the command palette (Ctrl/Cmd+P) and search for "AI Math Paste" or the names below.

- **Convert \( \) and \[ \] in current note**
- **Convert \( \) and \[ \] in selection**
- **Batch convert folder (this folder only)**
- **Batch convert folder (including subfolders)**
- **Clear batch conversion backups**

## Settings

- **Convert on paste** (off by default): converts pasted text that contains `\( \)` or `\[ \]`. Formatting from rich-text sources is not kept.
- **Show notices** (on by default): shows how many formulas were converted.
- **Back up files before batch conversion** (on by default): see Backups below.
- **Clear batch backups:** button that deletes all saved backups, after confirmation.

## Backups

With backups on, each batch conversion saves the original of every changed file in:

```
.obsidian/plugins/ai-math-paste/backups/<timestamp>/
```

The folder structure of your vault is kept inside each backup run. Batch conversion can't be undone with Ctrl/Cmd+Z, so keep backups on unless you have another copy of your notes.

Backups are never deleted automatically. Use the **Clear batch conversion backups** command or the settings button to remove them. Reinstalling the plugin may also delete them, so copy any backups you need first.

## Installation

1. Download `main.js` and `manifest.json` from the latest release.
2. Create the folder `YourVault/.obsidian/plugins/ai-math-paste/` and copy both files into it.
3. In Obsidian, open Settings → Community plugins. Turn off Restricted mode if it is on.
4. Enable **AI Math Paste**.

Requires Obsidian 1.4.0 or later.

## Limitations

- **Rich-text paste:** with *Convert on paste* on, formatted text is pasted as plain text, so bold, links, and other formatting are lost.
- **Drag and drop** is not converted.
- **Adjacent inline formulas**, such as `\(a\)\(b\)`, become `$a$$b$`, which Obsidian may not render as two formulas. Add a space between them by hand.
- **Indented code blocks** (4-space indent) are not protected. Fenced code blocks and inline code are.
- **Block quotes and lists:** a display formula on a line that starts with `>` or `-` is converted to `$$` lines without that prefix, which can break the quote or list. Check those lines after converting.
- **Row spacing:** `\\[6pt]` and `\\[2pt]` line-break spacing is left alone.
- **Inline formulas** `\( … \)` must stay on one line. Display formulas `\[ … \]` may span several lines.
- **Doubled backslashes:** JSON-escaped text such as `\\frac` is changed to `\frac`. Real LaTeX that uses `\\` before a command is rare, but check it if you have any.

## Development

The conversion rules are tested with Node.js scripts that use a stub of the Obsidian API. They are not included in this repository.

## License

MIT. See [LICENSE](LICENSE).
