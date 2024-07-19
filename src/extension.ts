import * as vscode from "vscode";
import * as cp from "child_process";
import { platform, arch } from "node:process";
import { quote } from "shell-quote";
import { prototype } from "mocha";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

const workspaceFolders: string[] | undefined =
  vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath);

const getRgPath = (extensionPath: string) => {
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

interface QuickPickItemWithLine extends vscode.QuickPickItem {
  num: number;
}

function fetchItems(
  command: string,
  dir: string
): Promise<QuickPickItemWithLine[]> {
  return new Promise((resolve, reject) => {
    if (dir === '') {
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

export function activate(context: vscode.ExtensionContext) {
  const rgPath = getRgPath(context.extensionUri.fsPath);
  let quickPickValue: string;

  const scrollBack: QuickPickItemWithLine[] = [];

  (async () => {
    const disposable = vscode.commands.registerCommand(
      "livegrep.search",
      async () => {
        if (!workspaceFolders) {
          // Fail gracefully if not in a directory or a workspace
          return;
        }
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = "Please enter a search term";
        quickPick.matchOnDescription = true;

        const isOption = (s: string) => /^--?[a-z]+/.test(s);
        const isWordQuoted = (s: string) => /^".*"/.test(s);

        quickPick.items = scrollBack;


        quickPick.onDidChangeValue(async (value) => {
          quickPickValue = value;
          if (!value || value === "") {
            return;
          }
          let query = value.split(/\s/).reduce((acc, curr, index) => {
            if (
              index === 0 ||
              isOption(curr) ||
              isOption(acc[acc.length - 1])
            ) {
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
          quickPick.items = ((await Promise.allSettled(workspaceFolders
            .map((dir) => fetchItems(quoteSearch, dir))))
            .map((result) => {
              if (result.status === "rejected") {
                vscode.window.showErrorMessage(result.reason);
              }
              return result;
            })
            .filter((result) => result.status === "fulfilled")
            .map((result) => result.value)).flat();
        });

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
      }
    );
    context.subscriptions.push(disposable);
  })().catch((error) => {
    vscode.window.showErrorMessage(error);
  });
}

export function deactivate() { }
