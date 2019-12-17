import * as vscode from 'vscode';
import createQuickPickCustom, { QuickPickCustomOptons } from './quickPickCustom';
import createWorkspacePick from './workspaceFolderPick';
import magento, { ExtensionInfo, ExtentionKind }  from './magento';
import createExtension from './actions/createExtension';
import injectDependency from './actions/injectDependency';
import addObserver from './actions/addObserver';
import addPlugin from './actions/addPlugin';
import generateCatalog from './actions/generateCatalog';
import Php, { ClassMethod, MethodVisibility } from './php';
import { MagentoTaskProvider } from './actions/MagentoTaskProvider';
import { definitionProvider } from './actions/definitionProvider';
import Indexer from './indexer';
import * as output from './output';

export function activate(context: vscode.ExtensionContext) {

    async function getWorkspaceFolder(): Promise <vscode.WorkspaceFolder | undefined> {
        if (vscode.workspace.workspaceFolders) {
            let magentoFolders = [];
            for(let workspaceFolder of vscode.workspace.workspaceFolders) {
                if (!magento.indexer[workspaceFolder.uri.fsPath]) {
                    magento.indexer[workspaceFolder.uri.fsPath] = new Indexer(context, workspaceFolder);
                }
                if (await magento.indexer[workspaceFolder.uri.fsPath].magentoRoot) {
                    magentoFolders.push(workspaceFolder);
                }
            }
            if (magentoFolders.length === 1) {
                return magentoFolders[0];
            }

            return createWorkspacePick(magentoFolders, { title: 'Select workspace folder' });
        } else {
            // no workspace folders
            return undefined;
        }
    }

    async function getVendorExtension(options?: QuickPickCustomOptons): Promise<ExtensionInfo | undefined> {
        if (!options) {
            options = {};
        }
        options.step = options.step || 1;
        options.totalSteps = options.totalSteps || 2;
        let currentWorkspace: vscode.WorkspaceFolder | undefined;
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace folders found');
        }
        currentWorkspace = await getWorkspaceFolder();
        if (!currentWorkspace) {
            return undefined;
        }
        magento.folder = currentWorkspace;
        let vendors = magento.getVendors();
        let vendor = await createQuickPickCustom(vendors, Object.assign({}, options, { title: options.custom ? 'Please enter Vendor name' : 'Please select Vendor' }));
        let extension;
        if (vendor) {
            options.step++;
            if (options.custom) {
                extension = await createQuickPickCustom([], Object.assign({}, options, { title: 'Enter Extension Name' }));
            } else {
                let extensions = magento.getExtensions(vendor);
                extension = await createQuickPickCustom(extensions, Object.assign({}, options, { title: 'Please select Extension' }));
            }
            if (extension) {
                // return magento.indexer[currentWorkspace.uri.fsPath].findByVendorExtension(vendor, extension);
                if (magento.indexer[currentWorkspace.uri.fsPath]) {
                    magento.folder = currentWorkspace;
                    let data = magento.getIndexer().findByVendorExtension(vendor, extension);
                    if (data) {
                        // extension exists, return it's data from index
                        return data;
                    }
                    // extension would be created
                    let extensionFolder = magento.appendUri(await magento.getAppCodeUri(), vendor, extension).fsPath;
                    return {
                        workspace: currentWorkspace,
                        vendor,
                        extension,
                        extensionFolder,
                        componentName: vendor+'_'+extension,
                        extensionUri: magento.appendUri(currentWorkspace.uri, extensionFolder),
                    };
                }
            }
        } else {
            return undefined;
        }
    }
    try {
        if (vscode.workspace.workspaceFolders) {
            for(let workspaceFolder of vscode.workspace.workspaceFolders) {
                context.subscriptions.push(vscode.tasks.registerTaskProvider(MagentoTaskProvider.MagentoScriptType, new MagentoTaskProvider(workspaceFolder)));
                try {
                    magento.indexer[workspaceFolder.uri.fsPath] = new Indexer(context, workspaceFolder);
                    magento.indexer[workspaceFolder.uri.fsPath].magentoRoot.then(magentoRoot => {
                        if (magentoRoot) {
                            output.log('Found Magento root at', magentoRoot.fsPath);
                            output.log(' - Modules:', magento.indexer[workspaceFolder.uri.fsPath].paths.module.length);
                            output.log(' - Themes:', magento.indexer[workspaceFolder.uri.fsPath].paths.theme.length);

                        } else {
                            output.log(`No Magento root in '${workspaceFolder.name}' workspace folder (${workspaceFolder.uri.fsPath})`);
                        }
                    });
                } catch(e) {
                    vscode.window.showErrorMessage(e.message);
                }
            }
        }

        context.subscriptions.push(vscode.commands.registerCommand('magentowizard.newExtension', async () => {
            const data = await getVendorExtension({ custom: true });
            if (!data) {
                return;
            }
            magento.folder = data.workspace;
            try {
                await createExtension(data.vendor, data.extension);
                vscode.window.showInformationMessage(`Created extension ${data.vendor}_${data.extension}`);
            } catch (e) {
                vscode.window.showErrorMessage(e.message);
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('magentowizard.injectDependency', async () => {
            let textEditor = vscode.window.activeTextEditor;
            try {
                if (!textEditor || textEditor.document.languageId !== 'php') {
                    // TODO add separate message when there is no open file
                    throw new Error('Only supported for PHP files');
                }
                let data = await magento.getUriData(textEditor.document.uri);
                if (!data || !data.vendor || !data.extension) {
                    throw new Error('Not a Magento 2 extension file');
                }
                let folder = vscode.workspace.getWorkspaceFolder(textEditor.document.uri);
                if (folder) {
                    magento.folder = folder;
                }
                if (textEditor) {
                    let className = await createQuickPickCustom(magento.getClasses(data), { step: 1, totalSteps: 2, title: 'Please select class or interface to inject' });
                    if (className) {
                        var varName = await vscode.window.showInputBox({
                            prompt: 'Enter variable name',
                            value: magento.suggestVariableName(className),
                            validateInput: value => { return !value.match(/^\$?[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*$/) ? 'Incorrect variable name' : '' ; },
                        });
                        if (varName) {
                            await injectDependency(textEditor, className, varName);
                        }
                    }
                }
            } catch(e) {
                vscode.window.showErrorMessage(e.message);
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('magentowizard.addObserver', async () => {
            let textEditor = vscode.window.activeTextEditor;
            let step, totalSteps;
            try {
                let extensionData;
                if (textEditor) {
                    try {
                        extensionData = await magento.getUriData(textEditor.document.uri);
                        totalSteps = 2;
                        step = 1;
                    } catch {}
                }
                if (!extensionData || !extensionData.vendor || !extensionData.extension) {
                    totalSteps = 4;
                    step = 3;
                    extensionData = await getVendorExtension({ custom: false, totalSteps });
                }
                if (!extensionData || !extensionData.vendor || !extensionData.extension) {
                    return;
                }
                let eventName = await createQuickPickCustom(magento.getEvents(), { custom: true, step, totalSteps, title: 'Please select event name' });
                if (eventName) {
                    var observerName = await vscode.window.showInputBox({
                        prompt: 'Enter observer class name',
                        value: magento.suggestObserverName(eventName),
                        validateInput: value => { return !magento.validateClassName(value) ? 'Incorrect class name' : '' ; },
                    });
                    if (observerName) {
                        await addObserver(extensionData, eventName, observerName!);
                    }
                }
            } catch (e) {
                vscode.window.showErrorMessage(e.message);
            }
        }));

        context.subscriptions.push(vscode.commands.registerCommand('magentowizard.addPlugin', async () => {
            let textEditor = vscode.window.activeTextEditor;
            let step = 1, totalSteps = 4;
            try {
                let extensionData;
                if (textEditor) {
                    try {
                        extensionData = await magento.getUriData(textEditor.document.uri);
                    } catch {}
                }
                if (!extensionData || !extensionData.vendor || !extensionData.extension) {
                    totalSteps = 6;
                    step = 3;
                    extensionData = await getVendorExtension({ custom: false, totalSteps });
                }
                if (!extensionData || !extensionData.vendor || !extensionData.extension) {
                    return;
                }
                let className = await createQuickPickCustom(magento.getClasses(extensionData), { custom: true, step, totalSteps, title: 'Please enter or select class in which you want to intercept method call' });
                if (!className) { return; }

                let classFile = await magento.getClassFile(extensionData, className);

                let methods: ClassMethod[] = [];
                if (classFile) {
                    methods = await magento.getClassMethods(classFile);
                }
                let methodsNames: string[] = [];
                if (methods) {
                    methodsNames = methods
                        .filter(method => method.visibility === MethodVisibility.public && method.name !== '__construct' )
                        .map(method => {
                            let params: string[] = method.parameters.map(param => (param.type ? param.type + ' $' : '$') + param.name);
                            return method.name+'('+params.join(', ')+')';
                        });
                }
                step++;
                let methodSelected= await createQuickPickCustom(methodsNames, { custom: true, step, totalSteps, title: 'Please enter or select method you want to intercept' });
                if (!methodSelected) { return; }
                const methodMatches = methodSelected.match(/^([a-zA-Z0-9_]+)\(?/);
                if (!methodMatches) { return; }
                let methodName = methodMatches[1];
                let method = methods.find(function (this: string, method) { return method.name === this; }, methodName);
                if (!method) {
                    method = {
                        name: methodName,
                        visibility: MethodVisibility.public,
                        parameters: [
                            {
                                name: 'arg1',
                                type: '',
                                value: '',
                            }
                        ]
                    };
                }

                step++;
                let pluginType = await createQuickPickCustom(['before', 'after', 'around'], { custom: false, step, totalSteps, title: 'Please select plugin type' });
                if (!pluginType) { return; }

                var pluginName = await vscode.window.showInputBox({
                    prompt: 'Enter plugin class name',
                    value: magento.suggestPluginName(className),
                    validateInput: value => { return !magento.validateClassName(value) ? 'Incorrect class name' : '' ; },
                });
                if (!pluginName) { return; }

                await addPlugin(extensionData, className, method, pluginType, pluginName);
            } catch (e) {
                vscode.window.showErrorMessage(e.message);
            }
        }));

        context.subscriptions.push(vscode.commands.registerCommand('magentowizard.generateCatalog', async () => {
            let textEditor = vscode.window.activeTextEditor;
            try {
                let currentWorkspace;
                if (!vscode.workspace.workspaceFolders) {
                    throw new Error('No open workspace folders');
                }
                if (vscode.workspace.workspaceFolders.length > 1) {
                    currentWorkspace = await vscode.window.showWorkspaceFolderPick();
                } else {
                    currentWorkspace = vscode.workspace.workspaceFolders[0];
                }
                if (currentWorkspace) {
                    await generateCatalog(context, currentWorkspace);
                }
            } catch (e) {
                vscode.window.showErrorMessage(e.message);
            }
        }));

        let lastOpenedDocument: vscode.TextDocument | undefined;
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(textDocument => {
            lastOpenedDocument = textDocument;
        }));
        context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(async textEditors => {
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (lastOpenedDocument && activeEditor && activeEditor.document.uri.toString() === lastOpenedDocument.uri.toString()) {
                    await magento.applyTemplate(activeEditor);
                }
                lastOpenedDocument = undefined;
            } catch (e) {
                console.error(e);
            }
        }));

        context.subscriptions.push(vscode.languages.registerDefinitionProvider([
            {language: 'xml', scheme: 'file'},
            {language: 'xml', scheme: 'untitled'},
        ], definitionProvider));
    } catch(e) {
        output.log('Unhandled exception', e.name, e.message, e.stack);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    output.dispose();
}
