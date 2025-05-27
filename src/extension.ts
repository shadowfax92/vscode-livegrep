import * as vscode from "vscode";
import * as cp from "child_process";
import { platform, arch } from "node:process";
import { quote } from "shell-quote";
import * as path from "path";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

const workspaceFolders: string[] | undefined =
  vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath);

const getRgPath = (extensionPath: string) => {
  // Check if user has configured a custom rg path
  const customRgPath = vscode.workspace.getConfiguration('livegrep').get<string>('rgPath');
  if (customRgPath && customRgPath.trim() !== '') {
    return customRgPath;
  }

  // Use bundled version
  const binVersion = "13_0_0";
  const basePath = `${extensionPath}/bin/${binVersion}`;
  switch (platform) {
    case "darwin":
      return `${basePath}/${platform}/rg`;
    case "linux":
      if (arch === "arm" || arch === "arm64") {
        return `${basePath}/${platform}/rg_arm`;
      } else if (arch === "x64") {
        return `${basePath}/${platform}/rg_x86_64`;
      }
    case "win32":
      return `${basePath}/${platform}/rg.exe`;
    default:
      return "rg";
  }
};

const getFdPath = () => {
  // Check if user has configured a custom fd path
  const customFdPath = vscode.workspace.getConfiguration('livegrep').get<string>('fdPath');
  if (customFdPath && customFdPath.trim() !== '') {
    return customFdPath;
  }

  // Use system PATH
  return "fd";
};

interface QuickPickItemWithLine extends vscode.QuickPickItem {
  num: number;
}

interface QuickPickItemFile extends vscode.QuickPickItem {
  filePath: string;
}

function truncatePath(pwdString: string, maxLength: number = 30): string {
  if (pwdString.length <= maxLength) {
    return pwdString;
  }
  
  // Take the last maxLength characters and prepend with "..."
  const truncated = pwdString.slice(-maxLength);
  return `...${truncated}`;
}

// Helper function to detect if search term has uppercase letters (for case sensitivity)
function hasUpperCase(str: string): boolean {
  return /[A-Z]/.test(str);
}

// Helper function to build fd command with sensible defaults
function buildFdCommand(fdPath: string, searchTerm: string): string[] {
  const args = [];
  
  // Add case sensitivity based on search term
  if (!hasUpperCase(searchTerm)) {
    args.push("--ignore-case");
  }
  
  // Sensible defaults based on fd documentation
  // fd respects .gitignore and .ignore files by default
  args.push(
    "--type", "f",           // Only files, not directories
    "--hidden",              // Include hidden files
    "--follow",              // Follow symbolic links
    "--color", "never",      // No color output for parsing
    "--absolute-path"        // Return absolute paths
  );
  
  // Add the search pattern
  args.push(searchTerm);
  
  return [fdPath, ...args];
}

function fetchFileItems(
  command: string,
  dir: string
): Promise<QuickPickItemFile[]> {
  return new Promise((resolve, reject) => {
    if (dir === "") {
      reject(new Error("Can't parse dir ''"));
    }
    
    cp.exec(
      command,
      { cwd: dir, maxBuffer: MAX_BUF_SIZE },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`fd command failed: ${err.message}`));
          return;
        }
        
        if (stderr && !stdout) {
          reject(new Error(stderr));
          return;
        }
        
        const lines = stdout.split(/\n/).filter((l) => l !== "");
        
        if (!lines.length) {
          resolve([]);
          return;
        }
        
        const results = lines.map((filePath) => {
          const fileName = path.basename(filePath);
          const relativePath = path.relative(dir, filePath);
          return {
            label: fileName,
            description: relativePath,
            detail: filePath,
            filePath: filePath,
          };
        });
        
        resolve(results);
      }
    );
  });
}

function fetchItems(
  command: string,
  dir: string
): Promise<QuickPickItemWithLine[]> {
  return new Promise((resolve, reject) => {
    if (dir === "") {
      reject(new Error("Can't parse dir ''"));
    }
    cp.exec(
      command,
      { cwd: dir, maxBuffer: MAX_BUF_SIZE },
      (err, stdout, stderr) => {
        if (stderr) {
          reject(new Error(stderr));
        }
        const lines = stdout.split(/\n/).filter((l) => l !== "");
        if (!lines.length) {
          resolve([]);
        }
        resolve(
          lines
            .map((line) => {
              const [fullPath, num, ...desc] = line.split(":");
              const description = desc.join(":").trim();
              return {
                fullPath,
                num: Number(num),
                line,
                description,
              };
            })
            .filter(
              ({ description, num }) =>
                description.length < MAX_DESC_LENGTH && !!num
            )
            .map(({ fullPath, num, line, description }) => {
              const path = fullPath.split("/");
              return {
                label: `${path[path.length - 1]} : ${num}`,
                description,
                detail: dir + fullPath.substring(1, fullPath.length),
                num,
              };
            })
        );
      }
    );
  });
}

interface SearchResult {
  filePath: string;
  fileName: string;
  lineNumber: number;
  content: string;
  relativePath: string;
}

function createWebviewSearchPanel(context: vscode.ExtensionContext, rgPath: string, workspaceFolders: string[]) {
  const panel = vscode.window.createWebviewPanel(
    'livegrepWebview',
    'LiveGrep Search',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
      retainContextWhenHidden: true
    }
  );

  panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'search':
          const results = await performWebviewSearch(rgPath, workspaceFolders, message.query);
          panel.webview.postMessage({ command: 'searchResults', results });
          break;
        case 'openFile':
          await openFileAtLine(message.filePath, message.lineNumber);
          break;
        case 'previewFile':
          const preview = await getFilePreview(message.filePath, message.lineNumber, message.query);
          panel.webview.postMessage({ command: 'filePreview', preview, filePath: message.filePath });
          break;
      }
    },
    undefined,
    context.subscriptions
  );
}

async function performWebviewSearch(rgPath: string, dirs: string[], query: string): Promise<SearchResult[]> {
  if (!query || query.trim() === '') {
    return [];
  }

  const results: SearchResult[] = [];
  
  for (const dir of dirs) {
    try {
      const rgArgs = [rgPath, "-n", "-i", query, "."];
      const command = quote(rgArgs);
      
      const searchResults = await new Promise<SearchResult[]>((resolve, reject) => {
        cp.exec(command, { cwd: dir, maxBuffer: MAX_BUF_SIZE }, (err, stdout, stderr) => {
          if (err && !stdout) {
            resolve([]);
            return;
          }
          
          const lines = stdout.split(/\n/).filter(l => l !== "");
          const dirResults = lines.map(line => {
            const [fullPath, lineNum, ...contentParts] = line.split(":");
            const content = contentParts.join(":").trim();
            const fileName = path.basename(fullPath);
            const relativePath = path.relative(dir, path.resolve(dir, fullPath));
            
            return {
              filePath: path.resolve(dir, fullPath),
              fileName,
              lineNumber: parseInt(lineNum, 10),
              content,
              relativePath
            };
          }).filter(result => result.content.length < MAX_DESC_LENGTH);
          
          resolve(dirResults);
        });
      });
      
      results.push(...searchResults);
    } catch (error) {
      console.error(`Search failed in ${dir}:`, error);
    }
  }
  
  return results;
}

async function openFileAtLine(filePath: string, lineNumber: number) {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);
    const position = new vscode.Position(lineNumber - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to open file: ${error}`);
  }
}

async function getFilePreview(filePath: string, lineNumber: number, searchQuery: string): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    const totalLines = doc.lineCount;
    const contextLines = 5;
    
    const startLine = Math.max(0, lineNumber - contextLines - 1);
    const endLine = Math.min(totalLines - 1, lineNumber + contextLines - 1);
    
    let preview = '';
    for (let i = startLine; i <= endLine; i++) {
      const line = doc.lineAt(i);
      const lineNum = i + 1;
      const isTargetLine = lineNum === lineNumber;
      
      let content = escapeHtml(line.text);
      if (isTargetLine && searchQuery) {
        // Highlight search term (case insensitive) after HTML escaping
        const escapedQuery = escapeRegex(escapeHtml(searchQuery));
        const regex = new RegExp(`(${escapedQuery})`, 'gi');
        content = content.replace(regex, '<mark>$1</mark>');
      }
      
      preview += `<div class="line ${isTargetLine ? 'target-line' : ''}" data-line="${lineNum}">`;
      preview += `<span class="line-number">${lineNum}</span>`;
      preview += `<span class="line-content">${content}</span>`;
      preview += `</div>`;
    }
    
    return preview;
  } catch (error) {
    return `<div class="error">Failed to load file preview: ${error}</div>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LiveGrep Search</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .search-container {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-sideBar-background);
        }
        
        .search-input {
            width: 100%;
            padding: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-family: inherit;
            font-size: inherit;
        }
        
        .search-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .main-content {
            flex: 1;
            display: flex;
            overflow: hidden;
        }
        
        .results-panel {
            width: 40%;
            border-right: 1px solid var(--vscode-panel-border);
            overflow-y: auto;
            background-color: var(--vscode-sideBar-background);
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* Internet Explorer 10+ */
        }
        
        .results-panel::-webkit-scrollbar {
            display: none; /* WebKit */
        }
        
        .preview-panel {
            flex: 1;
            overflow-y: auto;
            background-color: var(--vscode-editor-background);
            padding: 10px;
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* Internet Explorer 10+ */
        }
        
        .preview-panel::-webkit-scrollbar {
            display: none; /* WebKit */
        }
        
        .result-item {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
            cursor: pointer;
            transition: background-color 0.1s;
        }
        
        .result-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .result-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        .result-filename {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 2px;
        }
        
        .result-path {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .result-line-number {
            font-size: 0.85em;
            color: var(--vscode-editorLineNumber-foreground);
            margin-top: 2px;
            font-style: italic;
        }
        
        .preview-content {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.4;
        }
        
        .line {
            display: flex;
            padding: 2px 0;
            border-radius: 2px;
        }
        
        .line.target-line {
            background-color: var(--vscode-editor-findMatchHighlightBackground);
        }
        
        .line-number {
            color: var(--vscode-editorLineNumber-foreground);
            width: 50px;
            text-align: right;
            margin-right: 10px;
            user-select: none;
            flex-shrink: 0;
        }
        
        .line-content {
            flex: 1;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }
        
        mark {
            background-color: var(--vscode-editor-findMatchBackground);
            color: var(--vscode-editor-findMatchForeground);
            border-radius: 2px;
            padding: 1px 2px;
        }
        
        .no-results {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .loading {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .error {
            color: var(--vscode-errorForeground);
            padding: 10px;
        }
        
        .preview-header {
            padding: 10px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 10px;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
    </style>
</head>
<body>
    <div class="search-container">
        <input type="text" class="search-input" placeholder="Enter search term..." id="searchInput">
    </div>
    
    <div class="main-content">
        <div class="results-panel" id="resultsPanel">
            <div class="no-results">Enter a search term to begin</div>
        </div>
        
        <div class="preview-panel" id="previewPanel">
            <div class="no-results">Select a file to preview</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('searchInput');
        const resultsPanel = document.getElementById('resultsPanel');
        const previewPanel = document.getElementById('previewPanel');
        
        let currentResults = [];
        let selectedIndex = -1;
        let searchTimeout;
        
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const query = e.target.value.trim();
            
            if (query === '') {
                showNoResults();
                return;
            }
            
            searchTimeout = setTimeout(() => {
                performSearch(query);
            }, 300);
        });
        
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigateResults(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigateResults(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (selectedIndex >= 0 && currentResults[selectedIndex]) {
                    openSelectedFile();
                }
            }
        });
        
        function performSearch(query) {
            showLoading();
            vscode.postMessage({
                command: 'search',
                query: query
            });
        }
        
        function showLoading() {
            resultsPanel.innerHTML = '<div class="loading">Searching...</div>';
            previewPanel.innerHTML = '<div class="no-results">Searching...</div>';
        }
        
        function showNoResults() {
            resultsPanel.innerHTML = '<div class="no-results">Enter a search term to begin</div>';
            previewPanel.innerHTML = '<div class="no-results">Select a file to preview</div>';
            currentResults = [];
            selectedIndex = -1;
        }
        
        function displayResults(results) {
            currentResults = results;
            selectedIndex = -1;
            
            if (results.length === 0) {
                resultsPanel.innerHTML = '<div class="no-results">No results found</div>';
                previewPanel.innerHTML = '<div class="no-results">No results found</div>';
                return;
            }
            
                         const html = results.map((result, index) => \`
                 <div class="result-item" data-index="\${index}">
                     <div class="result-filename">\${escapeHtml(result.fileName)}</div>
                     <div class="result-path">\${escapeHtml(result.relativePath)}</div>
                     <div class="result-line-number">Line \${result.lineNumber}</div>
                 </div>
             \`).join('');
            
            resultsPanel.innerHTML = html;
            
            // Add click handlers
            resultsPanel.querySelectorAll('.result-item').forEach((item, index) => {
                item.addEventListener('click', () => {
                    selectResult(index);
                });
            });
            
            // Auto-select first result
            if (results.length > 0) {
                selectResult(0);
            }
        }
        
        function selectResult(index) {
            if (index < 0 || index >= currentResults.length) return;
            
            // Update visual selection
            resultsPanel.querySelectorAll('.result-item').forEach((item, i) => {
                item.classList.toggle('selected', i === index);
            });
            
            selectedIndex = index;
            const result = currentResults[index];
            
            // Request file preview
            vscode.postMessage({
                command: 'previewFile',
                filePath: result.filePath,
                lineNumber: result.lineNumber,
                query: searchInput.value
            });
        }
        
        function navigateResults(direction) {
            if (currentResults.length === 0) return;
            
            const newIndex = selectedIndex + direction;
            if (newIndex >= 0 && newIndex < currentResults.length) {
                selectResult(newIndex);
                
                // Scroll selected item into view
                const selectedItem = resultsPanel.querySelector('.result-item.selected');
                if (selectedItem) {
                    selectedItem.scrollIntoView({ block: 'nearest' });
                }
            }
        }
        
        function openSelectedFile() {
            if (selectedIndex >= 0 && currentResults[selectedIndex]) {
                const result = currentResults[selectedIndex];
                vscode.postMessage({
                    command: 'openFile',
                    filePath: result.filePath,
                    lineNumber: result.lineNumber
                });
            }
        }
        
        function displayPreview(preview, filePath) {
            const fileName = filePath.split('/').pop() || filePath;
            previewPanel.innerHTML = \`
                <div class="preview-header">\${escapeHtml(fileName)}</div>
                <div class="preview-content">\${preview}</div>
            \`;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'searchResults':
                    displayResults(message.results);
                    break;
                case 'filePreview':
                    displayPreview(message.preview, message.filePath);
                    break;
            }
        });
        
        // Focus search input on load
        searchInput.focus();
    </script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
  const rgPath = getRgPath(context.extensionUri.fsPath);
  const fdPath = getFdPath();
  let quickPickValue: string;

  const scrollBack: QuickPickItemWithLine[] = [];
  const fileScrollBack: QuickPickItemFile[] = [];

  async function searchDirs(dirs: string[], title?: string, initialValue?: string) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = "Please enter a search term";
    quickPick.matchOnDescription = true;
    
    // Set initial value if provided
    if (initialValue) {
      quickPick.value = initialValue;
    }
    
    // Set title to show which directory is being searched
    if (title) {
      quickPick.title = title;
    } else if (dirs.length === 1) {
      quickPick.title = `Searching in: ${dirs[0]}`;
    } else {
      quickPick.title = `Searching in ${dirs.length} directories`;
    }

    const isOption = (s: string) => /^--?[a-z]+/.test(s);
    const isWordQuoted = (s: string) => /^".*"/.test(s);

    quickPick.items = scrollBack;

    const handleValueChange = async (value: string) => {
      quickPickValue = value;
      if (!value || value === "") {
        return;
      }
      let query = value.split(/\s/).reduce((acc, curr, index) => {
        if (index === 0 || isOption(curr) || isOption(acc[acc.length - 1])) {
          if (!isWordQuoted(curr) && !isOption(curr)) {
            acc.push("-i", curr); // add case insensitive flag
            return acc;
          }
          acc.push(curr.replace(/"/g, "")); // remove quotes
          return acc;
        }
        acc[acc.length - 1] = acc[acc.length - 1] + ` ${curr}`;
        return acc;
      }, [] as string[]);

      const quoteSearch = quote([rgPath, "-n", ...query, "."]);
      quickPick.items = (
        await Promise.allSettled(
          dirs.map((dir) => fetchItems(quoteSearch, dir))
        )
      )
        .map((result) => {
          if (result.status === "rejected") {
            vscode.window.showErrorMessage(result.reason);
          }
          return result;
        })
        .filter((result) => result.status === "fulfilled")
        .map((result) => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          return [];
        })
        .flat();
    };

    quickPick.onDidChangeValue(handleValueChange);

    quickPick.onDidAccept(async () => {
      const item = quickPick.selectedItems[0] as QuickPickItemWithLine;
      if (!item) {
        return;
      }

      if (item.description === "History") {
        quickPick.value = item.label;
        return;
      }

      // Create scrollback item to store history
      const scrollBackItem = {
        label: quickPickValue,
        description: "History",
        num: 0,
      };
      // Scrollback history is limited to 20 items
      if (scrollBack.length > 20) {
        // Remove oldest item
        scrollBack.pop();
      }
      scrollBack.unshift(scrollBackItem);

      const { detail, num } = item;
      const doc = await vscode.workspace.openTextDocument("" + detail);
      await vscode.window.showTextDocument(doc);
      if (!vscode.window.activeTextEditor) {
        vscode.window.showErrorMessage("No active editor.");
        return;
      }
      vscode.window.activeTextEditor.selection = new vscode.Selection(
        ~~num,
        0,
        ~~num,
        0
      );
      vscode.commands.executeCommand("cursorUp");
    });

    quickPick.show();
    
    // If initial value is provided, trigger search immediately
    if (initialValue) {
      handleValueChange(initialValue);
    }
  }

  async function searchFiles(dirs: string[], title?: string, initialValue?: string) {
    const quickPick = vscode.window.createQuickPick<QuickPickItemFile>();
    quickPick.placeholder = "Please enter a file name pattern";
    quickPick.matchOnDescription = true;
    
    // Set initial value if provided
    if (initialValue) {
      quickPick.value = initialValue;
    }
    
    // Set title to show which directory is being searched
    if (title) {
      quickPick.title = title;
    } else if (dirs.length === 1) {
      quickPick.title = `Finding files in: ${truncatePath(dirs[0])}`;
    } else {
      quickPick.title = `Finding files in ${dirs.length} directories`;
    }

    quickPick.items = fileScrollBack;

    const handleFileValueChange = async (value: string) => {
      quickPickValue = value;
      if (!value || value === "") {
        return;
      }

      // Build fd command with sensible defaults
      const fdArgs = buildFdCommand(fdPath, value);
      const quoteSearch = quote(fdArgs);
      
      quickPick.items = (
        await Promise.allSettled(
          dirs.map((dir) => fetchFileItems(quoteSearch, dir))
        )
      )
        .map((result) => {
          if (result.status === "rejected") {
            vscode.window.showErrorMessage(result.reason);
          }
          return result;
        })
        .filter((result) => result.status === "fulfilled")
        .map((result) => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          return [];
        })
        .flat();
    };

    quickPick.onDidChangeValue(handleFileValueChange);

    quickPick.onDidAccept(async () => {
      const item = quickPick.selectedItems[0] as QuickPickItemFile;
      if (!item) {
        return;
      }

      if (item.description === "History") {
        quickPick.value = item.label;
        return;
      }

      // Create scrollback item to store history
      const scrollBackItem = {
        label: quickPickValue,
        description: "History",
        filePath: "",
      };
      // Scrollback history is limited to 20 items
      if (fileScrollBack.length > 20) {
        // Remove oldest item
        fileScrollBack.pop();
      }
      fileScrollBack.unshift(scrollBackItem);

      const { filePath } = item;
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
      quickPick.hide();
    });

    quickPick.show();
    
    // If initial value is provided, trigger search immediately
    if (initialValue) {
      handleFileValueChange(initialValue);
    }
  }

  (async () => {
    const disposableWorkspace = vscode.commands.registerCommand(
      "livegrep.search",
      async (initialValue?: string) => {
        if (!workspaceFolders) {
          vscode.window.showErrorMessage(
            "Open a workspace or a folder for Livegrep: Search Workspace to work"
          );
          return;
        }
        const title = initialValue ? `Searching workspace for: ${initialValue}` : undefined;
        searchDirs(workspaceFolders, title, initialValue);
      }
    );
    context.subscriptions.push(disposableWorkspace);

    const disposableCurrent = vscode.commands.registerCommand(
      "livegrep.searchCurrent",
      async (initialValue?: string) => {
        if (!vscode.window.activeTextEditor) {
          vscode.window.showErrorMessage("No active editor.");
          return;
        }
        let pwd = vscode.Uri.parse(
          vscode.window.activeTextEditor.document.uri.path
        );
        let pwdString = pwd.path;
        if (
          (await vscode.workspace.fs.stat(pwd)).type === vscode.FileType.File
        ) {
          pwdString = path.dirname(pwdString);
        }
        const title = initialValue 
          ? `Searching in current directory for: ${initialValue}` 
          : `Searching in current directory: ${truncatePath(pwdString)}`;
        searchDirs([pwdString], title, initialValue);
      }
    );
    context.subscriptions.push(disposableCurrent);

    const searchLevel = async (level: number, initialValue?: string) => {
      if (!vscode.window.activeTextEditor) {
        vscode.window.showErrorMessage("No active editor.");
        return;
      }
      let pwd = vscode.Uri.parse(
        vscode.window.activeTextEditor.document.uri.path
      );
      let pwdString = pwd.path;
      if (
        (await vscode.workspace.fs.stat(pwd)).type === vscode.FileType.File
      ) {
        pwdString = path.dirname(pwdString);
      }
      
      // Go up 'level' number of directories
      for (let i = 0; i < level; i++) {
        pwdString = path.dirname(pwdString);
      }
      
      // Create descriptive title based on level
      let title: string;
      if (initialValue) {
        title = `Level ${level} grep for: ${initialValue} in: ${truncatePath(pwdString)}`;
      } else {
        title = `Level ${level} grep in: ${truncatePath(pwdString)}`;
      }
      
      searchDirs([pwdString], title, initialValue);
    };

    // Register commands for different levels
    for (let level = 0; level <= 5; level++) {
      const disposableLevel = vscode.commands.registerCommand(
        `livegrep.searchLevel_${level}`,
        async (initialValue?: string) => {
          await searchLevel(level, initialValue);
        }
      );
      context.subscriptions.push(disposableLevel);
    }

    // File search commands using fd
    const disposableSearchFiles = vscode.commands.registerCommand(
      "livegrep.searchFiles",
      async (initialValue?: string) => {
        if (!workspaceFolders) {
          vscode.window.showErrorMessage(
            "Open a workspace or a folder for LiveGrep: Search Files to work"
          );
          return;
        }
        const title = initialValue ? `Finding files matching: ${initialValue}` : undefined;
        searchFiles(workspaceFolders, title, initialValue);
      }
    );
    context.subscriptions.push(disposableSearchFiles);

    const disposableSearchFilesCurrent = vscode.commands.registerCommand(
      "livegrep.searchFilesCurrent",
      async (initialValue?: string) => {
        if (!vscode.window.activeTextEditor) {
          vscode.window.showErrorMessage("No active editor.");
          return;
        }
        let pwd = vscode.Uri.parse(
          vscode.window.activeTextEditor.document.uri.path
        );
        let pwdString = pwd.path;
        if (
          (await vscode.workspace.fs.stat(pwd)).type === vscode.FileType.File
        ) {
          pwdString = path.dirname(pwdString);
        }
        const title = initialValue 
          ? `Finding files in current directory matching: ${initialValue}` 
          : `Finding files in current directory: ${truncatePath(pwdString)}`;
        searchFiles([pwdString], title, initialValue);
      }
    );
    context.subscriptions.push(disposableSearchFilesCurrent);

    const searchFilesLevel = async (level: number, initialValue?: string) => {
      if (!vscode.window.activeTextEditor) {
        vscode.window.showErrorMessage("No active editor.");
        return;
      }
      let pwd = vscode.Uri.parse(
        vscode.window.activeTextEditor.document.uri.path
      );
      let pwdString = pwd.path;
      if (
        (await vscode.workspace.fs.stat(pwd)).type === vscode.FileType.File
      ) {
        pwdString = path.dirname(pwdString);
      }
      
      // Go up 'level' number of directories
      for (let i = 0; i < level; i++) {
        pwdString = path.dirname(pwdString);
      }
      
      // Create descriptive title based on level
      let title: string;
      if (initialValue) {
        title = `Level ${level} find files matching: ${initialValue} in: ${truncatePath(pwdString)}`;
      } else {
        title = `Level ${level} find files in: ${truncatePath(pwdString)}`;
      }
      
      searchFiles([pwdString], title, initialValue);
    };

    // Register file search commands for different levels
    for (let level = 0; level <= 5; level++) {
      const disposableFilesLevel = vscode.commands.registerCommand(
        `livegrep.searchFilesLevel_${level}`,
        async (initialValue?: string) => {
          await searchFilesLevel(level, initialValue);
        }
      );
      context.subscriptions.push(disposableFilesLevel);
    }

    // Webview search command
    const disposableWebviewSearch = vscode.commands.registerCommand(
      "livegrep.webviewSearch",
      async () => {
        if (!workspaceFolders) {
          vscode.window.showErrorMessage(
            "Open a workspace or a folder for LiveGrep: Webview Search to work"
          );
          return;
        }
        createWebviewSearchPanel(context, rgPath, workspaceFolders);
      }
    );
    context.subscriptions.push(disposableWebviewSearch);

  })().catch((error) => {
    vscode.window.showErrorMessage(error);
  });
}

export function deactivate() {}
