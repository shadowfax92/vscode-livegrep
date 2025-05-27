import * as vscode from "vscode";
import * as cp from "child_process";
import { quote } from "shell-quote";
import * as path from "path";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

interface SearchResult {
  filePath: string;
  fileName: string;
  lineNumber: number;
  content: string;
  relativePath: string;
}

async function performWebviewSearchLive(
  rgPath: string, 
  dirs: string[], 
  query: string,
  onResult: (result: SearchResult) => void,
  onComplete: () => void,
  onError: (error: string) => void
): Promise<void> {
  if (!query || query.trim() === '') {
    onComplete();
    return;
  }

  let processCount = dirs.length;
  
  for (const dir of dirs) {
    try {
      const rgArgs = ["-n", "-i", query, "."];
      const rgProcess = cp.spawn(rgPath, rgArgs, { 
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let buffer = '';
      
      rgProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        
        // Keep the last incomplete line in buffer
        buffer = lines.pop() || '';
        
        // Process complete lines immediately
        for (const line of lines) {
          if (line.trim() === '') continue;
          
          const [fullPath, lineNum, ...contentParts] = line.split(":");
          if (!fullPath || !lineNum) continue;
          
          const content = contentParts.join(":").trim();
          if (content.length > MAX_DESC_LENGTH) continue;
          
          const fileName = path.basename(fullPath);
          const relativePath = path.relative(dir, path.resolve(dir, fullPath));
          
          const result: SearchResult = {
            filePath: path.resolve(dir, fullPath),
            fileName,
            lineNumber: parseInt(lineNum, 10),
            content,
            relativePath
          };
          
          // Send result immediately as it comes in
          onResult(result);
        }
      });

      rgProcess.on('close', (code) => {
        // Process any remaining buffer content
        if (buffer.trim()) {
          const line = buffer.trim();
          const [fullPath, lineNum, ...contentParts] = line.split(":");
          if (fullPath && lineNum) {
            const content = contentParts.join(":").trim();
            if (content.length <= MAX_DESC_LENGTH) {
              const fileName = path.basename(fullPath);
              const relativePath = path.relative(dir, path.resolve(dir, fullPath));
              
              const result: SearchResult = {
                filePath: path.resolve(dir, fullPath),
                fileName,
                lineNumber: parseInt(lineNum, 10),
                content,
                relativePath
              };
              
              onResult(result);
            }
          }
        }
        
        processCount--;
        if (processCount === 0) {
          onComplete();
        }
      });

      rgProcess.on('error', (error) => {
        console.error(`Search failed in ${dir}:`, error);
        processCount--;
        if (processCount === 0) {
          onComplete();
        }
      });

    } catch (error) {
      console.error(`Search failed in ${dir}:`, error);
      processCount--;
      if (processCount === 0) {
        onComplete();
      }
    }
  }
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

async function getFilePreview(filePath: string, lineNumber: number, searchQuery: string, contextLines: number = 20): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    const totalLines = doc.lineCount;
    
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

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, initialQuery?: string): string {
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
        
        .search-status {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
            min-height: 16px;
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
        <div class="search-status" id="searchStatus"></div>
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
        const searchStatus = document.getElementById('searchStatus');
        
        let currentResults = [];
        let selectedIndex = -1;
        let searchTimeout;
        let isSearching = false;
        
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
        
        // Global keyboard navigation (works even when search input doesn't have focus)
        document.addEventListener('keydown', (e) => {
            // Only handle if not typing in search input or if using Ctrl combinations
            if (e.target !== searchInput || e.ctrlKey) {
                if (e.ctrlKey && e.key === 'n') {
                    e.preventDefault();
                    navigateResults(1);
                } else if (e.ctrlKey && e.key === 'p') {
                    e.preventDefault();
                    navigateResults(-1);
                } else if (e.target !== searchInput) {
                    // Allow arrow keys when not in search input
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
                }
            }
        });
        
        function performSearch(query) {
            isSearching = true;
            showLoading();
            searchStatus.textContent = 'Searching...';
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
            isSearching = false;
            searchStatus.textContent = '';
        }
        
        function addResult(result) {
            currentResults.push(result);
            
            // Update status
            searchStatus.textContent = \`Found \${currentResults.length} result\${currentResults.length === 1 ? '' : 's'}...\`;
            
            // Update the display incrementally
            const resultHtml = \`
                <div class="result-item" data-index="\${currentResults.length - 1}">
                    <div class="result-filename">\${escapeHtml(result.fileName)}</div>
                    <div class="result-path">\${escapeHtml(result.relativePath)}</div>
                    <div class="result-line-number">Line \${result.lineNumber}</div>
                </div>
            \`;
            
            // If this is the first result, clear the loading message
            if (currentResults.length === 1) {
                resultsPanel.innerHTML = resultHtml;
                // Auto-select first result
                selectResult(0);
            } else {
                // Append new result
                resultsPanel.insertAdjacentHTML('beforeend', resultHtml);
            }
            
            // Add click handler to the new result
            const newItem = resultsPanel.lastElementChild;
            newItem.addEventListener('click', () => {
                selectResult(currentResults.length - 1);
            });
        }
        
        function clearResults() {
            currentResults = [];
            selectedIndex = -1;
            resultsPanel.innerHTML = '<div class="loading">Searching...</div>';
            previewPanel.innerHTML = '<div class="no-results">Searching...</div>';
        }
        
        function searchComplete() {
            isSearching = false;
            if (currentResults.length === 0) {
                resultsPanel.innerHTML = '<div class="no-results">No results found</div>';
                previewPanel.innerHTML = '<div class="no-results">No results found</div>';
                searchStatus.textContent = 'No results found';
            } else {
                searchStatus.textContent = \`Found \${currentResults.length} result\${currentResults.length === 1 ? '' : 's'}\`;
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
                
                // Instant scroll with no animation
                const selectedItem = resultsPanel.querySelector('.result-item.selected');
                if (selectedItem) {
                    selectedItem.scrollIntoView({ 
                        block: 'nearest', 
                        behavior: 'instant' 
                    });
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
                case 'clearResults':
                    clearResults();
                    break;
                case 'addResult':
                    addResult(message.result);
                    break;
                case 'searchComplete':
                    searchComplete();
                    break;
                case 'searchError':
                    console.error('Search error:', message.error);
                    searchComplete();
                    break;
                case 'filePreview':
                    displayPreview(message.preview, message.filePath);
                    break;
            }
        });
        
        // Set initial query if provided
        const initialQuery = '${initialQuery || ''}';
        if (initialQuery) {
            searchInput.value = initialQuery;
            // Trigger search after a short delay to ensure everything is ready
            setTimeout(() => {
                performSearch(initialQuery);
            }, 100);
        }
        
        // Focus search input on load
        searchInput.focus();
        
        // Notify extension that webview is ready
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
}

export function createWebviewSearchPanel(
  context: vscode.ExtensionContext, 
  rgPath: string, 
  searchDirs: string[],
  initialQuery?: string,
  title?: string,
  contextLines: number = 20,
  autoClose: boolean = true
) {
  const panel = vscode.window.createWebviewPanel(
    'livegrepWebview',
    title || 'LiveGrep Search',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
      retainContextWhenHidden: true
    }
  );

  panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, initialQuery);

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'search':
          // Clear previous results and start live search
          panel.webview.postMessage({ command: 'clearResults' });
          
          await performWebviewSearchLive(
            rgPath, 
            searchDirs, 
            message.query,
            // onResult: send each result immediately
            (result) => {
              panel.webview.postMessage({ 
                command: 'addResult', 
                result 
              });
            },
            // onComplete: search finished
            () => {
              panel.webview.postMessage({ 
                command: 'searchComplete' 
              });
            },
            // onError: handle errors
            (error) => {
              panel.webview.postMessage({ 
                command: 'searchError', 
                error 
              });
            }
          );
          break;
        case 'openFile':
          await openFileAtLine(message.filePath, message.lineNumber);
          if (autoClose) {
            panel.dispose();
          }
          break;
        case 'previewFile':
          const preview = await getFilePreview(message.filePath, message.lineNumber, message.query, contextLines);
          panel.webview.postMessage({ command: 'filePreview', preview, filePath: message.filePath });
          break;
        case 'ready':
          // Webview is ready, trigger initial search if query provided
          if (initialQuery) {
            panel.webview.postMessage({ command: 'clearResults' });
            await performWebviewSearchLive(
              rgPath, 
              searchDirs, 
              initialQuery,
              (result) => {
                panel.webview.postMessage({ 
                  command: 'addResult', 
                  result 
                });
              },
              () => {
                panel.webview.postMessage({ 
                  command: 'searchComplete' 
                });
              },
              (error) => {
                panel.webview.postMessage({ 
                  command: 'searchError', 
                  error 
                });
              }
            );
          }
          break;
      }
    },
    undefined,
    context.subscriptions
  );
}

function truncatePath(pwdString: string, maxLength: number = 30): string {
  if (pwdString.length <= maxLength) {
    return pwdString;
  }
  
  // Take the last maxLength characters and prepend with "..."
  const truncated = pwdString.slice(-maxLength);
  return `...${truncated}`;
}

export function registerWebviewSearchCommand(
  context: vscode.ExtensionContext,
  rgPath: string,
  workspaceFolders: string[] | undefined
) {
  const getContextLines = () => {
    return vscode.workspace.getConfiguration('livegrep').get<number>('contextLines') || 20;
  };
  
  const getAutoCloseWebview = () => {
    return vscode.workspace.getConfiguration('livegrep').get<boolean>('autoCloseWebview') ?? true;
  };
  // Workspace webview search
  const disposableWebviewSearch = vscode.commands.registerCommand(
    "livegrep.webviewSearch",
    async (initialQuery?: string) => {
      if (!workspaceFolders) {
        vscode.window.showErrorMessage(
          "Open a workspace or a folder for LiveGrep: Webview Search to work"
        );
        return;
      }
      const title = initialQuery 
        ? `LiveGrep: Searching workspace for "${initialQuery}"` 
        : "LiveGrep: Search Workspace";
      createWebviewSearchPanel(context, rgPath, workspaceFolders, initialQuery, title, getContextLines(), getAutoCloseWebview());
    }
  );
  context.subscriptions.push(disposableWebviewSearch);

  // Current folder webview search
  const disposableWebviewSearchCurrent = vscode.commands.registerCommand(
    "livegrep.webviewSearchCurrent",
    async (initialQuery?: string) => {
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
      const title = initialQuery 
        ? `LiveGrep: Searching "${initialQuery}" in ${truncatePath(pwdString)}` 
        : `LiveGrep: Search in ${truncatePath(pwdString)}`;
      createWebviewSearchPanel(context, rgPath, [pwdString], initialQuery, title, getContextLines(), getAutoCloseWebview());
    }
  );
  context.subscriptions.push(disposableWebviewSearchCurrent);

  // Level-based webview search
  const webviewSearchLevel = async (level: number, initialQuery?: string) => {
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
    if (initialQuery) {
      title = `LiveGrep: Level ${level} search for "${initialQuery}" in ${truncatePath(pwdString)}`;
    } else {
      title = `LiveGrep: Level ${level} search in ${truncatePath(pwdString)}`;
    }
    
    createWebviewSearchPanel(context, rgPath, [pwdString], initialQuery, title, getContextLines(), getAutoCloseWebview());
  };

  // Register webview commands for different levels
  for (let level = 0; level <= 5; level++) {
    const disposableWebviewLevel = vscode.commands.registerCommand(
      `livegrep.webviewSearchLevel_${level}`,
      async (initialQuery?: string) => {
        await webviewSearchLevel(level, initialQuery);
      }
    );
    context.subscriptions.push(disposableWebviewLevel);
  }
} 