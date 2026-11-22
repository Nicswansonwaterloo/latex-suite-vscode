import { dirname, posix } from "node:path";
import * as vscode from "vscode";

/** Watch the configured entries themselves, including missing files and atomic replacements.
 * Only directories discovered by the loader need a recursive watcher. */
export class SnippetFileWatcher implements vscode.Disposable {
	private readonly targets = new Map<string, {
		entry?: vscode.FileSystemWatcher;
		children?: vscode.FileSystemWatcher;
	}>();
	private timer?: NodeJS.Timeout;

	constructor(uris: readonly vscode.Uri[], private readonly reload: () => void) {
		const sources = new Set(uris.map(uri => uri.toString()));
		for (const source of uris) {
			const workspaceRoot = vscode.workspace.getWorkspaceFolder(source)?.uri.toString();
			let uri = source;
			while (!this.targets.has(uri.toString())) {
				const key = uri.toString();
				const name = posix.basename(uri.path);
				if (!name || (uri.scheme === "file" && dirname(uri.fsPath) === uri.fsPath)) {
					this.targets.set(key, {});
					break;
				}
				const parent = vscode.Uri.joinPath(uri, "..");
				// Quote glob metacharacters in literal configured names, e.g. "snippets[1].js".
				const pattern = name.replace(/[\[\]{}*?]/g, (character) => `[${character}]`);
				const entry = this.watch(new vscode.RelativePattern(parent, pattern), !sources.has(key));
				this.targets.set(key, { entry });
				// A provider can report just the renamed/deleted ancestor. Its entry needs
				// a nonrecursive watch, without listening for ordinary directory changes.
				if (key === workspaceRoot || !uri.path.startsWith("/") || parent.path === uri.path) { break; }
				uri = parent;
			}
		}
	}

	setDirectory(uri: vscode.Uri, directory: boolean): void {
		const target = this.targets.get(uri.toString());
		if (!target) {
			return;
		}
		if (directory && !target.children) {
			target.children = this.watch(new vscode.RelativePattern(uri, "**/*"));
		} else if (!directory && target.children) {
			target.children.dispose();
			target.children = undefined;
		}
	}

	private watch(pattern: vscode.RelativePattern, ignoreChanges = false): vscode.FileSystemWatcher {
		const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, ignoreChanges, false);
		const changed = (uri: vscode.Uri) => {
			// Different workspace providers can report identical paths.
			if (uri.scheme !== pattern.baseUri.scheme || uri.authority !== pattern.baseUri.authority) {
				return;
			}
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.reload();
			}, 150);
		};
		if (!ignoreChanges) {
			watcher.onDidChange(changed);
		}
		watcher.onDidCreate(changed);
		watcher.onDidDelete(changed);
		return watcher;
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (const target of this.targets.values()) {
			target.entry?.dispose();
			target.children?.dispose();
		}
		this.targets.clear();
	}
}
