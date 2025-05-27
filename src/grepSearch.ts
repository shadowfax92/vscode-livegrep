import * as vscode from "vscode";
import * as cp from "child_process";
import { quote } from "shell-quote";
import * as path from "path";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

interface QuickPickItemWithLine extends vscode.QuickPickItem {
  num: number;
}

// Helper function to detect if search term has uppercase letters (for case sensitivity)
function hasUpperCase(str: string): boolean {
  return /[A-Z]/.test(str);
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

function truncatePath(pwdString: string, maxLength: number = 30): string {
  if (pwdString.length <= maxLength) {
    return pwdString;
  }
  
  // Take the last maxLength characters and prepend with "..."
  const truncated = pwdString.slice(-maxLength);
  return `...${truncated}`;
}

export async function searchDirs(
  rgPath: string,
  dirs: string[], 
  scrollBack: QuickPickItemWithLine[],
  title?: string, 
  initialValue?: string
) {
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

  let quickPickValue: string;

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

export function registerGrepCommands(
  context: vscode.ExtensionContext,
  rgPath: string,
  workspaceFolders: string[] | undefined
) {
  const scrollBack: QuickPickItemWithLine[] = [];

  // Workspace search
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
      searchDirs(rgPath, workspaceFolders, scrollBack, title, initialValue);
    }
  );
  context.subscriptions.push(disposableWorkspace);

  // Current folder search
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
      searchDirs(rgPath, [pwdString], scrollBack, title, initialValue);
    }
  );
  context.subscriptions.push(disposableCurrent);

  // Level-based search
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
    
    searchDirs(rgPath, [pwdString], scrollBack, title, initialValue);
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
} 