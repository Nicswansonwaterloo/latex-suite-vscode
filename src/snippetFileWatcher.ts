import { dirname, posix } from "node:path";
import * as vscode from "vscode";

/** Watch the configured entries themselves, including missing files and atomic replacements.
 * Only directories discovered by the loader need a recursive watcher. */
export class SnippetFileWatcher implements vscode.Disposable {
	readonly ready: Promise<void>;
	private readonly pollers: PollingSourceWatcher[] = [];
	private readonly targets = new Map<string, {
		entry?: vscode.FileSystemWatcher;
		children?: vscode.FileSystemWatcher;
	}>();
	private timer?: NodeJS.Timeout;

	constructor(uris: readonly vscode.Uri[], private readonly reload: () => void) {
		const sources = new Set(uris.map(uri => uri.toString()));
		for (const source of uris) {
			if (process.platform === "win32" && source.scheme === "file") {
				// Native RelativePattern watchers can lock an ancestor against rename
				// on Windows: https://github.com/microsoft/vscode/issues/334673.
				// Metadata polling holds no directory handle, including for missing paths.
				if (!this.targets.has(source.toString())) {
					this.targets.set(source.toString(), {});
					this.pollers.push(new PollingSourceWatcher(source, () => this.changed()));
				}
				continue;
			}
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
		this.ready = Promise.all(this.pollers.map(poller => poller.ready)).then(() => {});
	}

	setDirectory(uri: vscode.Uri, directory: boolean): void {
		if (process.platform === "win32" && uri.scheme === "file") { return; }
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
			this.changed();
		};
		if (!ignoreChanges) {
			watcher.onDidChange(changed);
		}
		watcher.onDidCreate(changed);
		watcher.onDidDelete(changed);
		return watcher;
	}

	private changed(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.reload();
		}, 150);
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (const poller of this.pollers) { poller.dispose(); }
		for (const target of this.targets.values()) {
			target.entry?.dispose();
			target.children?.dispose();
		}
		this.targets.clear();
	}
}

/** Windows local sources must remain renamable while automatic reload is active. */
export class PollingSourceWatcher implements vscode.Disposable {
	readonly ready: Promise<void>;
	private timer?: NodeJS.Timeout;
	private disposed = false;
	private previous?: string;

	constructor(private readonly uri: vscode.Uri, private readonly changed: () => void) {
		this.ready = this.poll();
	}

	private async snapshot(uri: vscode.Uri): Promise<unknown[]> {
		if (this.disposed) { return []; }
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			const state: unknown[] = [uri.toString(), stat.type, stat.ctime, stat.mtime, stat.size];
			if (stat.type & vscode.FileType.Directory) {
				const entries = await vscode.workspace.fs.readDirectory(uri);
				for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
					// Match the loader's traversal; do not follow directory symlink cycles.
					if (type & (vscode.FileType.Directory | vscode.FileType.File)) {
						state.push(await this.snapshot(vscode.Uri.joinPath(uri, name)));
					}
				}
			}
			return state;
		} catch (error) {
			return [uri.toString(), error instanceof Error ? error.message : String(error)];
		}
	}

	private async poll(): Promise<void> {
		const current = JSON.stringify(await this.snapshot(this.uri));
		if (this.disposed) { return; }
		if (this.previous !== undefined && current !== this.previous) { this.changed(); }
		this.previous = current;
		// Schedule after the scan so slow or remote files never overlap polls.
		this.timer = setTimeout(() => { void this.poll(); }, 1000);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
	}
}
