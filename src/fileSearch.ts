import * as vscode from "vscode";
import * as cp from "child_process";
import { quote } from "shell-quote";
import * as path from "path";

const MAX_BUF_SIZE = 200000 * 1024;

interface QuickPickItemFile extends vscode.QuickPickItem {
  filePath: string;
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

function truncatePath(pwdString: string, maxLength: number = 30): string {
  if (pwdString.length <= maxLength) {
    return pwdString;
  }
  
  // Take the last maxLength characters and prepend with "..."
  const truncated = pwdString.slice(-maxLength);
  return `...${truncated}`;
}

export async function searchFiles(
  fdPath: string,
  dirs: string[], 
  fileScrollBack: QuickPickItemFile[],
  title?: string, 
  initialValue?: string
) {
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

  let quickPickValue: string;

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

export function registerFileSearchCommands(
  context: vscode.ExtensionContext,
  fdPath: string,
  workspaceFolders: string[] | undefined
) {
  const fileScrollBack: QuickPickItemFile[] = [];

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
      searchFiles(fdPath, workspaceFolders, fileScrollBack, title, initialValue);
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
      searchFiles(fdPath, [pwdString], fileScrollBack, title, initialValue);
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
    
    searchFiles(fdPath, [pwdString], fileScrollBack, title, initialValue);
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
} 