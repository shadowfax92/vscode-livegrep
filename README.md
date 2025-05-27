# vscode-livegrep
A ripgrep extension for Visual Studio Code to mimic Telescope in Neovim, in the command palette

## Features

- **Ripgrep Integration**: Use ripgrep as normal with live search results
- **File Search**: Fast file finding using fd (when available) or fallback methods
- **Level-based Search**: Search at specific directory levels (0-5 levels up from current file)
- **Workspace & Current Folder Search**: Search entire workspace or just current folder
- **Custom Binary Paths**: Configure custom paths for ripgrep and fd executables
- **Keyboard Shortcuts**: Bind livegrep commands to keyboard shortcuts
- **Search History**: View 10 previous search terms and results
- **Exact Match**: Use quotes for exact match searching
- **Multi-folder Workspace Support**: Works with workspaces containing multiple folders

![screenshot](https://github.com/abayomi185/vscode-livegrep/blob/main/docs/animation.gif?raw=true)

## Commands

### Text Search (Grep)
- `livegrep.search` - Search entire workspace
- `livegrep.searchCurrent` - Search current folder
- `livegrep.searchLevel_0` to `livegrep.searchLevel_5` - Search at specific directory levels

### File Search
- `livegrep.searchFiles` - Find files in workspace
- `livegrep.searchFilesCurrent` - Find files in current folder  
- `livegrep.searchFilesLevel_0` to `livegrep.searchFilesLevel_5` - Find files at specific directory levels

### Webview Search (New!)
- `livegrep.webviewSearch` - Open Telescope-like webview interface with split-pane search results and file preview
- `livegrep.webviewSearchCurrent` - Webview search in current folder
- `livegrep.webviewSearchLevel_0` to `livegrep.webviewSearchLevel_5` - Webview search at specific directory levels
  - **Keyboard shortcut**: `Ctrl+Shift+Alt+F` (Windows/Linux) or `Cmd+Shift+Alt+F` (Mac)
  - **Features**: 
    - Split-pane interface: file list on left, content preview on right
    - Syntax highlighting in preview
    - Context lines around matches
    - Highlighted search terms
    - Keyboard navigation (Arrow keys, Ctrl+N/P, Enter to open file)
    - Real-time search as you type
    - Supports initial query parameter for programmatic invocation

## Configuration

You can customize the paths to ripgrep and fd executables, as well as the webview search behavior in your VS Code settings:

```json
{
  "livegrep.rgPath": "/custom/path/to/rg",
  "livegrep.fdPath": "/custom/path/to/fd",
  "livegrep.contextLines": 20
}
```

### Configuration Options

- **`livegrep.rgPath`**: Custom path to ripgrep (rg) executable. Leave empty to use bundled version.
- **`livegrep.fdPath`**: Custom path to fd executable. Leave empty to use system PATH.
- **`livegrep.contextLines`**: Number of context lines to show before and after each match in webview search (default: 20, range: 0-100).

## Vim Configuration

If you're using the VSCode Neovim extension, here's a comprehensive setup based on Telescope-like keybindings:

### Basic Search Keybindings
```lua
local keymap = vim.keymap.set
local opts = { noremap = true, silent = true }

-- Basic search commands
keymap("n", "<leader>/", function()
  vim.fn.VSCodeNotify("livegrep.search")
end, opts)

keymap("n", "<leader>sg", function()
  vim.fn.VSCodeNotify("livegrep.searchCurrent")
end, opts)

-- File search
keymap("n", "<leader>ff", function()
  vim.fn.VSCodeNotify("livegrep.searchFiles")
end, opts)

keymap("n", "<leader>sf", function()
  vim.fn.VSCodeNotify("livegrep.searchFilesCurrent")
end, opts)

-- Webview search (Telescope-like interface)
keymap("n", "<leader>fw", function()
  vim.fn.VSCodeNotify("livegrep.webviewSearch")
end, opts)

keymap("n", "<leader>fc", function()
  vim.fn.VSCodeNotify("livegrep.webviewSearchCurrent")
end, opts)
```

### Level-based Search (Advanced)
```lua
-- Grep search at different directory levels
for i = 0, 5 do
  keymap("n", "<leader>kg" .. i, function()
    vim.fn.VSCodeNotify("livegrep.searchLevel_" .. i)
  end, opts)
end

-- File search at different directory levels  
for i = 0, 5 do
  keymap("n", "<leader>kf" .. i, function()
    vim.fn.VSCodeNotify("livegrep.searchFilesLevel_" .. i)
  end, opts)
end

-- Webview search at different directory levels
for i = 0, 5 do
  keymap("n", "<leader>kw" .. i, function()
    vim.fn.VSCodeNotify("livegrep.webviewSearchLevel_" .. i)
  end, opts)
end
```

### Visual Mode Search
```lua
-- Search for selected text
keymap("v", "<leader>/", function()
  local selection = vim.fn.expand("<cword>")
  vim.fn.VSCodeNotify("livegrep.search", selection)
end, opts)

keymap("v", "<leader>sc", function()
  local selection = vim.fn.expand("<cword>")
  vim.fn.VSCodeNotify("livegrep.searchCurrent", selection)
end, opts)

-- Visual file search
keymap("v", "<leader>sf", function()
  local selection = vim.fn.expand("<cword>")
  vim.fn.VSCodeNotify("livegrep.searchFilesCurrent", selection)
end, opts)
```

### Quick Access Shortcuts
```lua
-- Quick grep shortcuts
keymap("v", "rg", function()
  local selection = vim.fn.expand("<cword>")
  vim.fn.VSCodeNotify("livegrep.search", selection)
end, opts)

-- Quick file search
keymap("v", "rf", function()
  local selection = vim.fn.expand("<cword>")
  vim.fn.VSCodeNotify("workbench.action.quickOpen", selection)
end, opts)
```

## Acknowledgments

🙏 **Huge thanks to [@abayomi185](https://github.com/abayomi185/vscode-livegrep)** for creating the original vscode-livegrep extension! This project is based on their excellent work that brought ripgrep functionality to VS Code with a Telescope-like experience. The foundation they built made it possible to add all the enhanced features like level-based search, fd integration, and comprehensive file search capabilities.

Check out the original project: [abayomi185/vscode-livegrep](https://github.com/abayomi185/vscode-livegrep)

## Release Notes

### 0.5
- **Level-based Search**: Added support for searching at specific directory levels (0-5 levels up)
- **File Search with fd**: Integrated fd for fast file searching with fallback support
- **Custom Binary Paths**: Added settings to configure custom ripgrep and fd executable paths
- **Enhanced Commands**: Added comprehensive file search commands alongside existing grep functionality
- **Improved Performance**: Better search performance with fd integration

### 0.4
- Make workspaces with multiple folders supported
- Add livegrep.searchCurrent to search the current folder
- Fix bugs

### 0.3
- Bundle ripgrep binary for windows, linux and macOS in extension

### 0.2
- Dynamically changing list when typing search term
- Search term in quotes for exact match
- History list to view 10 previous search terms and search result
  
### 0.1
- Initial release
