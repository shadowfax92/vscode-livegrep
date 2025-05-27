import * as vscode from "vscode";
import { platform, arch } from "node:process";
import { registerGrepCommands } from "./grepSearch";
import { registerFileSearchCommands } from "./fileSearch";
import { registerWebviewSearchCommand } from "./webviewSearch";

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

const getContextLines = () => {
  // Get configured context lines, default to 20
  return vscode.workspace.getConfiguration('livegrep').get<number>('contextLines') || 20;
};

export function activate(context: vscode.ExtensionContext) {
  const rgPath = getRgPath(context.extensionUri.fsPath);
  const fdPath = getFdPath();

  try {
    // Register grep search commands
    registerGrepCommands(context, rgPath, workspaceFolders);
    
    // Register file search commands
    registerFileSearchCommands(context, fdPath, workspaceFolders);
    
    // Register webview search command
    registerWebviewSearchCommand(context, rgPath, workspaceFolders);
    
  } catch (error) {
    vscode.window.showErrorMessage(`LiveGrep activation failed: ${error}`);
  }
}

export function deactivate() {}
