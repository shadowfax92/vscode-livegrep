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
          vscode.window.showInformationMessage("There are no items.");
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
  (async () => {
    const disposable = vscode.commands.registerCommand(
      "livegrep.search",
      async () => {
        const query = await vscode.window.showInputBox({
          prompt: "Please input search word.",
        });
        const isOption = (s: string) => /^--?[a-z]+/.test(s);
        if (!query) {
          vscode.window.showErrorMessage("No search term has been entered.");
          return;
        }
        const q = query.split(/\s/).reduce((acc, c, i) => {
          if (i === 0 || isOption(c) || isOption(acc[acc.length - 1])) {
            acc.push(c);
            return acc;
          }
          acc[acc.length - 1] = acc[acc.length - 1] + ` ${c}`;
          return acc;
        }, [] as string[]);
        const command = quote([rgPath, "-n", ...q, "."]);
        const options: vscode.QuickPickOptions = { matchOnDescription: true };
        const item = await vscode.window.showQuickPick(
          fetchItems(command, projectRoot),
          options
        );
        if (!item) {
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
      }
    );
  })().catch((error) => {
    vscode.window.showErrorMessage(error);
  });
}

export function deactivate() {}
