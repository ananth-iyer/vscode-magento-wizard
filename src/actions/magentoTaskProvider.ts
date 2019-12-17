import * as vscode from 'vscode';
import magento from '../magento';
import * as output from '../output';

interface MagentoTaskDefinition extends vscode.TaskDefinition {
    /**
     * Command name
     */
    command: string;

    /**
     * Command arguments
     */
    args: string[];
}

export class MagentoTaskProvider implements vscode.TaskProvider {
    static MagentoScriptType: string = 'magento';
    private tasks: vscode.Task[] | undefined;
    private php: string = 'php';
    private user: string = '';
    private config: vscode.WorkspaceConfiguration;
    private folder: string;
    private sharedState: string | undefined;

    constructor(private workspaceFolder: vscode.WorkspaceFolder) {
        this.config = vscode.workspace.getConfiguration('', this.workspaceFolder.uri);
        this.folder = workspaceFolder.uri.fsPath;
        this.readConfig();
    }

    public async provideTasks(): Promise<vscode.Task[]> {
        return this.getTasks();
    }

    public resolveTask(_task: vscode.Task): vscode.Task | undefined {
        const command: string = _task.definition.command;
        if (command) {
            const definition: MagentoTaskDefinition = <any>_task.definition;
            return this.getTask(command, definition.args ? definition.args : [], definition);
        }
        return undefined;
    }

    private async getTasks(): Promise<vscode.Task[]> {
        if (this.tasks !== undefined) {
            return this.tasks;
        }
        let magentoRoot = await magento.indexer[this.folder].magentoRoot;

        if (!magentoRoot || !await magento.fileExists(magento.appendUri(magentoRoot, 'bin/magento'))) {
            // if there is no bin/magento in this workspace folder - return no tasks
            return [];
        }
        this.readConfig();
        let commandLine = (this.user ? `sudo -u ${this.user} ` : '') + `${this.php} bin/magento --no-ansi`;
        this.tasks = [];

        try {
            output.log(`Running '${commandLine}' in ${magentoRoot.fsPath}`);
            let { stdout, stderr } = await magento.exec(commandLine, { cwd: magentoRoot.fsPath });
            if (stdout) {
                let lines = stdout.split(/\r{0,1}\n/);
                let matchCommands = false;
                for (let line of lines) {
                    if (line.length === 0) {
                        continue;
                    }
                    if (line.match(/Available commands/)) {
                        matchCommands = true;
                    }

                    if (matchCommands) {
                        let matches = line.match(/^\s\s(?<command>.*?)\s/);
                        if (matches && matches.groups) {
                            this.tasks!.push(this.getTask(matches.groups.command, []));
                        }
                    }
                }
            }
        } catch (err) {
            output.log(`Error running '${commandLine}' in ${magentoRoot.fsPath}:`, err.stderr, err.stdout);
            if (err.stderr.match(/askpass/)) {
                vscode.window.showErrorMessage(`Can't run bin/magento as "${this.user}", please allow to sudo as that user without a password`, 'More info').then(value => {
                    if (value) {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/viperet/vscode-magento-wizard/wiki/Allow-sudo-to-run-commands-as-certain-user-without-password'));
                    }
                });
            } else {
                // TODO allow to disable task provider for this folder
                vscode.window.showErrorMessage(`Error running "${commandLine}":\n${err.stdout}`);
            }
            this.tasks = undefined;
            return [];
        }
        return this.tasks;
    }

    public getTask(command: string, args: string[], definition?: MagentoTaskDefinition): vscode.Task {
        if (definition === undefined) {
            definition = {
                type: MagentoTaskProvider.MagentoScriptType,
                command,
                args,
                problemMatcher: ['$magento'],
            };
        }
        this.readConfig();
        args = args.map(arg => arg.replace(/(["\s'$`\\])/, '\\$1'));
        const commandLine = (this.user ? `sudo -u ${this.user} ` : '') + `${this.php} bin/magento ${command} ${args.join(' ')}`;
        const task = new vscode.Task(
            definition,
            this.workspaceFolder,
            `${command} ${args.join(' ')}`,
            MagentoTaskProvider.MagentoScriptType,
            new vscode.ShellExecution(commandLine, { cwd: this.workspaceFolder.uri.fsPath }),
            ['$magento']
        );
        task.presentationOptions = {
            echo: true,
            focus: true,
            clear: true,
        };
        return task;
    }
    private readConfig() {
        this.config = vscode.workspace.getConfiguration('', this.workspaceFolder.uri);
        this.php = this.config.get('magentoWizard.tasks.php') || 'php';
        this.user = this.config.get('magentoWizard.tasks.user') || '';
    }
}