import * as vscode from "vscode";
import * as cp from "child_process";
import { rgPath } from "@vscode/ripgrep";
import { quote } from "shell-quote";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

const workspaceFolders: string[] =
  vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [];
const projectRoot = workspaceFolders[0] || ".";

interface QuickPickItemWithLine extends vscode.QuickPickItem {
  num: number;
}

function fetchItems(
  command: string,
  projectRoot: string
): Promise<QuickPickItemWithLine[]> {
  return new Promise((resolve, reject) => {
    cp.exec(
      command,
      { cwd: projectRoot, maxBuffer: MAX_BUF_SIZE },
      (err, stdout, stderr) => {
        if (stderr) {
          vscode.window.showErrorMessage(stderr);
          return resolve([]);
        }
        const lines = stdout.split(/\n/).filter((l) => l !== "");
        if (!lines.length) {
          return resolve([]);
        }
        return resolve(
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
                detail: fullPath,
                num,
              };
            })
        );
      }
    );
  });
}

export function activate(context: vscode.ExtensionContext) {
  let query: string[];
  const scrollBack: QuickPickItemWithLine[] = [];

  (async () => {
    const disposable = vscode.commands.registerCommand(
      "livegrep.search",
      async () => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = "Please enter a search term";
        quickPick.matchOnDescription = true;

        const isOption = (s: string) => /^--?[a-z]+/.test(s);
        const isWordQuoted = (s: string) => /^".*"/.test(s);

        quickPick.items = scrollBack;

        quickPick.onDidChangeValue(async (value) => {
          if (!value || value === "") {
            return;
          }
          query = value.split(/\s/).reduce((acc, curr, index) => {
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
          quickPick.items = await fetchItems(
            quote([rgPath, "-n", ...query, "."]),
            projectRoot
          );
        });

        quickPick.onDidAccept(async () => {
          // Create scrollback item when user makes selection
          const scrollBackItem = {
            label: query.join(" "),
            description: "History",
            num: scrollBack.length + 1,
          };

          // Scrollback history is limited to 10 items
          if (scrollBack.length > 10) {
            // remove oldest item
            scrollBack.shift();
          }
          scrollBack.unshift(scrollBackItem);

          const item = quickPick.selectedItems[0] as QuickPickItemWithLine;
          if (!item) {
            return;
          }
          if (item.description === "History") {
            // Add ability to select history item to replace current search
            quickPick.items = await fetchItems(
              quote([rgPath, "-n", ...item.label.split(/\s/), "."]),
              projectRoot
            );
            return;
          }
          const { detail, num } = item;
          const doc = await vscode.workspace.openTextDocument(
            projectRoot + "/" + detail
          );
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
          context.subscriptions.push(disposable);
        });

        quickPick.show();
      }
    );
  })().catch((error) => {
    vscode.window.showErrorMessage(error);
  });
}

export function deactivate() {}
