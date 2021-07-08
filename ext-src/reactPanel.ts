import * as path from 'path';
import { WebviewPanel, Disposable, ViewColumn, window, Uri, commands, Memento } from 'vscode';
import * as uuid from 'uuid/v4';
import axios from 'axios';
import { Logger, actionToast, updateUserSettings, retrieveUserSettings, getNonce } from './utils';
import { createAccWorker, createWorker } from './lib';
import { TokenData } from './types';

const logger = new Logger();

const authToken: TokenData = {
  token: retrieveUserSettings('ethcode.userConfig.appRegistration', 'token'),
  appId: retrieveUserSettings('ethcode.userConfig.appRegistration', 'appId'),
};

/**
 * Manages react webview panels
 */
// eslint-disable-next-line import/prefer-default-export
export class ReactPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: ReactPanel | undefined;

  private static readonly viewType = 'ethcode';

  private readonly _panel: WebviewPanel;

  private readonly _extensionPath: string;

  private _disposables: Disposable[] = [];

  private _disposed = false;

  private constructor(extensionPath: string, column: ViewColumn, workspaceState: Memento) {
    this._extensionPath = extensionPath;

    // Create and show a new webview panel
    this._panel = window.createWebviewPanel(ReactPanel.viewType, 'ETHcode', column, {
      // Enable javascript in the webview
      enableScripts: true,

      // And restric the webview to only loading content from our extension's `media` directory.
      localResourceRoots: [Uri.file(path.join(this._extensionPath, 'build'))],
    });

    // Set the webview's initial html content
    this._panel.webview.html = this._getHtmlForWebview();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: any) => {
        logger.log(`Worker message: ${JSON.stringify(message)}`);
        if (message.command === 'auth-updated') {
          const actionName = 'Reload';
          actionToast(
            'Authentication status updated. Please reload if you have changed your authtoken!',
            actionName
          ).then((item: string | undefined) => {
            if (item === actionName) commands.executeCommand('workbench.action.reloadWindow');
          });
        } else if (message.command === 'run-deploy') {
          this.runDeploy(message.payload, message.testNetId);
        } else if (message.command.endsWith('contract-method-call')) {
          this.runContractCall(message.payload, message.testNetId);
        } else if (message.command === 'run-get-gas-estimate') {
          this.runGetGasEstimate(message.payload, message.testNetId);
        } else if (message.command === 'getAccount') {
          const account = workspaceState.get('account');
          this._panel.webview.postMessage({ account });
        } else if (message.command === 'get-balance') {
          const balance = workspaceState.get('balance');
          this._panel.webview.postMessage({ balance });
        } else if (message.command === 'build-rawtx') {
          this.buildRawTx(message.payload, message.testNetId);
        } else if (message.command === 'sign-deploy-tx') {
          this.signDeployTx(message.payload, message.testNetId);
        } else if (message.command === 'gen-keypair') {
          this.genKeyPair(message.payload, this._extensionPath);
        } else if (message.command === 'delete-keyPair') {
          this.deleteKeyPair(message.payload, this._extensionPath);
        } else if (message.command === 'send-ether') {
          this.sendEther(message.payload, message.testNetId);
        } else if (message.command === 'send-ether-signed') {
          this.sendEtherSigned(message.payload, message.testNetId);
        } else if (message.command === 'get-pvt-key') {
          this.getPvtKey(message.payload, this._extensionPath);
        } else if (message.command === 'get-contract') {
          const contract = workspaceState.get('contract');
          this._panel.webview.postMessage({ contract });
        } else if (message.command === 'get-network') {
          const networkId = workspaceState.get('networkId');
          this._panel.webview.postMessage({ networkId });
        }
      },
      null,
      this._disposables
    );
  }

  public postMessage(msg: any) {
    this._panel.webview.postMessage(msg);
  }

  public static createOrShow(extensionPath: string, workspaceState: Memento) {
    const column = window.activeTextEditor ? ViewColumn.Beside : undefined;

    // If we already have a panel, show it.
    // Otherwise, create a new panel.
    if (ReactPanel.currentPanel) {
      try {
        ReactPanel.currentPanel._panel.reveal(column);
        ReactPanel.currentPanel.checkFileName();
        ReactPanel.currentPanel.checkAppRegistration();
      } catch (error) {
        logger.error(error);
      }
    } else {
      try {
        ReactPanel.currentPanel = new ReactPanel(extensionPath, column || ViewColumn.Active, workspaceState);
        ReactPanel.currentPanel.checkFileName();
        ReactPanel.currentPanel.checkAppRegistration();
      } catch (error) {
        logger.error(error);
      }
    }
  }

  public checkFileName() {
    window.onDidChangeActiveTextEditor((changeEvent) => {
      // @ts-ignore
      const panelName = changeEvent && changeEvent._documentData ? changeEvent._documentData._uri.fsPath : undefined;

      const regexVyp = /([a-zA-Z0-9\s_\\.\-\\(\\):])+(.vy|.v.py|.vyper.py)$/g;
      const regexSol = /([a-zA-Z0-9\s_\\.\-\\(\\):])+(.sol|.solidity)$/g;

      if (this._disposed) {
        // @ts-ignore
      } else if (panelName && panelName.match(regexVyp) && panelName.match(regexVyp).length > 0) {
        // @ts-ignore
        this._panel.webview.postMessage({ fileType: 'vyper' });
        // @ts-ignore
      } else if (panelName && panelName.match(regexSol) && panelName.match(regexSol).length > 0) {
        // @ts-ignore
        this._panel.webview.postMessage({ fileType: 'solidity' });
      } else {
        this._panel.webview.postMessage({ fileType: 'none' });
      }
    });
  }

  public async checkAppRegistration(): Promise<void> {
    // const registered = await registerAppToToken();
    this._panel.webview.postMessage({ registered: true });
  }

  public getTokens = async (): Promise<boolean> => {
    try {
      const token = await window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: 'Enter App Token from dApp Auth',
      });
      const email = await window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: 'Enter email regitered from dApp Auth',
      });
      if (token || email) {
        const appId = uuid();
        await axios.post('https://auth.ethcode.dev/user/token/app/add', {
          email,
          app_id: appId,
          token,
        });
        const settingsData = {
          appId,
          email,
          token,
        };
        await updateUserSettings('userConfig.appRegistration.token', settingsData.token!);
        await updateUserSettings('userConfig.appRegistration.appId', settingsData.appId!);
        await updateUserSettings('userConfig.appRegistration.email', settingsData.email!);
        return true;
      }
      return false;
    } catch (error) {
      logger.log(error);
      logger.log(error.response.data.Error);
      return false;
    }
  };

  private genKeyPair(password: string, ksPath: string): void {
    const accWorker = createAccWorker();
    logger.log(`Account worker invoked with WorkerID : ${accWorker.pid}.`);
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      if (m.account) {
        this._panel.webview.postMessage({ newAccount: m.account });
      }
      if (m.localAddresses) {
        this._panel.webview.postMessage({ localAccounts: m.localAddresses });
      } else if (m.error) {
        this._panel.webview.postMessage({ error: m.error });
      }
    });
    accWorker.send({ command: 'create-account', pswd: password, ksPath });
  }

  // get private key for given public key
  private getPvtKey(pubKey: string, keyStorePath: string) {
    const accWorker = createAccWorker();
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      // TODO: handle private key not found errors
      if (m.privateKey) {
        this._panel.webview.postMessage({ pvtKey: m.privateKey });
      }
    });
    accWorker.send({
      command: 'extract-privateKey',
      address: pubKey,
      keyStorePath,
      pswd: '',
    });
  }

  private deleteKeyPair(publicKey: string, keyStorePath: string) {
    const accWorker = createAccWorker();
    accWorker.on('message', (m: any) => {
      logger.log(`Account worker message: ${JSON.stringify(m)}`);
      if (m.resp) {
        logger.success(m.resp);
        this._panel.webview.postMessage({ resp: m.resp });
      } else {
        logger.error(m.error);
      }

      if (m.localAddresses) {
        this._panel.webview.postMessage({ localAccounts: m.localAddresses });
      }
    });
    accWorker.send({
      command: 'delete-keyPair',
      address: publicKey,
      keyStorePath,
    });
  }

  // create unsigned transactions
  private buildRawTx(payload: any, testNetId: string) {
    const txWorker = createWorker();
    txWorker.on('message', (m: any) => {
      logger.log(`Transaction worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        this._panel.webview.postMessage({ errors: m.error });
      } else {
        this._panel.webview.postMessage({ buildTxResult: m.buildTxResult });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    txWorker.send({
      command: 'build-rawtx',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // Deploy contracts for ganache
  private runDeploy(payload: any, testNetId: string) {
    const deployWorker = createWorker();
    deployWorker.on('message', (m: any) => {
      logger.log(`Deploy worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        this._panel.webview.postMessage({ errors: m.error });
      } else {
        this._panel.webview.postMessage({ deployedResult: m });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    deployWorker.send({
      command: 'deploy-contract',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // sign & deploy unsigned contract transactions
  private signDeployTx(payload: any, testNetId: string) {
    const signedDeployWorker = createWorker();
    signedDeployWorker.on('message', (m: any) => {
      logger.log(`SignDeploy worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        this._panel.webview.postMessage({ errors: m.error });
      } else if (m.transactionResult) {
        this._panel.webview.postMessage({
          deployedResult: m.transactionResult,
        });
        this._panel.webview.postMessage({
          transactionResult: m.transactionResult,
        });
        logger.success('Contract transaction submitted!');
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    signedDeployWorker.send({
      command: 'sign-deploy',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // call contract method
  private runContractCall(payload: any, testNetId: string) {
    logger.log('Running contract call...');
    const callWorker = createWorker();
    callWorker.on('message', (m: any) => {
      logger.log(`Call worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error);
        this._panel.webview.postMessage({ errors: m.error });
      } else if (m.unsignedTx) {
        this._panel.webview.postMessage({ unsignedTx: m.unsignedTx });
      } else {
        this._panel.webview.postMessage({ ganacheCallResult: m.callResult });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    logger.log(`testnet Id: ${testNetId}`);
    if (testNetId === 'ganache') {
      callWorker.send({
        command: 'ganache-contract-method-call',
        payload,
        authToken,
        testnetId: testNetId,
      });
    } else {
      callWorker.send({
        command: 'contract-method-call',
        payload,
        authToken,
        testnetId: testNetId,
      });
    }
  }

  // Get gas estimates
  private runGetGasEstimate(payload: any, testNetId: string) {
    const deployWorker = createWorker();
    deployWorker.on('message', (m: any) => {
      logger.log(`Gas worker message: ${JSON.stringify(m)}`);
      if (m.error) {
        logger.error(m.error);
        this._panel.webview.postMessage({ errors: JSON.stringify(m.error) });
      } else {
        this._panel.webview.postMessage({ gasEstimate: m.gasEstimate });
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    deployWorker.send({
      command: 'get-gas-estimate',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // Send ether on ganache
  private sendEther(payload: any, testNetId: string) {
    const sendEtherWorker = createWorker();
    sendEtherWorker.on('message', (m: any) => {
      logger.log(`Ether worker message: ${JSON.stringify(m)}`);
      if (m.transactionResult) {
        this._panel.webview.postMessage({
          transactionResult: m.transactionResult,
        });
        logger.success('Successfully sent Ether');
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    sendEtherWorker.send({
      command: 'send-ether',
      transactionInfo: payload,
      authToken,
      testnetId: testNetId,
    });
  }

  // Send ether using ethereum client
  private sendEtherSigned(payload: any, testNetId: string) {
    const sendEtherWorker = createWorker();
    sendEtherWorker.on('message', (m: any) => {
      logger.log(`Ether worker message: ${JSON.stringify(m)}`);
      if (m.unsignedTx) {
        this._panel.webview.postMessage({ unsignedTx: m.unsignedTx });
      } else if (m.transactionResult) {
        this._panel.webview.postMessage({
          transactionResult: m.transactionResult,
        });
        logger.success('Successfully sent Ether');
      }
    });
    if (authToken.appId === '' && authToken.token === '') {
      logger.error(new Error('App Not registered'));
      return;
    }
    sendEtherWorker.send({
      command: 'send-ether-signed',
      payload,
      authToken,
      testnetId: testNetId,
    });
  }

  public dispose() {
    if (this._disposed) {
      return;
    }
    ReactPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();
    this._disposed = true;

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview() {
    // eslint-disable-next-line global-require, import/no-dynamic-require,  @typescript-eslint/no-var-requires
    const manifest = require(path.join(this._extensionPath, 'build', 'asset-manifest.json')).files;
    const mainScript = manifest['main.js'];
    const mainStyle = manifest['main.css'];
    const scriptPathOnDisk = Uri.file(path.join(this._extensionPath, 'build', mainScript));
    const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
    const stylePathOnDisk = Uri.file(path.join(this._extensionPath, 'build', mainStyle));
    const styleUri = stylePathOnDisk.with({ scheme: 'vscode-resource' });
    // Use a nonce to whitelist which scripts can be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
        <meta name="theme-color" content="#000000">
        <title>ETH code</title>
        <link rel="stylesheet" type="text/css" href="${styleUri}">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;">
        <base href="${Uri.file(path.join(this._extensionPath, 'build')).with({ scheme: 'vscode-resource' })}/">
      </head>

      <body>
        <noscript>You need to enable JavaScript to run this app.</noscript>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}
