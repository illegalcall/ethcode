/* eslint-disable @typescript-eslint/no-var-requires */
import { ethers } from 'ethers'
import * as fs from 'fs'
import * as vscode from 'vscode'
import { window, type InputBoxOptions } from 'vscode'
import { event } from '../api/api'
import { logger } from '../lib'
import { type Account, type LocalAddressType } from '../types'
import {
  getSelectedNetwork,
  getSelectedProvider,
  getSelectedNetConf,
  isTestingNetwork
} from './networks'

const keythereum = require('keythereum')

// List all local addresses
const listAddresses: any = async (
  context: vscode.ExtensionContext,
  keyStorePath: string
): Promise<string[]> => {
  try {
    if (isTestingNetwork(context) === true) {
      const provider = getSelectedProvider(
        context
      ) as ethers.providers.JsonRpcProvider
      const account = await provider.listAccounts()
      return account
    }

    if (!fs.existsSync(`${keyStorePath}/keystore`)) {
      fs.mkdirSync(`${keyStorePath}/keystore`)
    }

    const files = fs.readdirSync(`${keyStorePath}/keystore`)

    const localAddresses: LocalAddressType[] = files.map((file) => {
      const arr = file.split('--')
      return {
        pubAddress: `0x${arr[arr.length - 1]}`,
        checksumAddress: ethers.utils.getAddress(`0x${arr[arr.length - 1]}`)
      }
    })

    return localAddresses.map((e) => e.pubAddress)
  } catch (err) {
    logger.error(err)
    return []
  }
}

// Create keypair
const createKeyPair: any = (context: vscode.ExtensionContext, path: string, pswd: string) => {
  try {
    const params = { keyBytes: 32, ivBytes: 16 }
    const bareKey = keythereum.create(params)
    const options = {
      kdf: 'scrypt',
      cipher: 'aes-128-ctr'
    }
    const keyObject = keythereum.dump(
      Buffer.from(pswd, 'utf-8'),
      bareKey.privateKey,
      bareKey.salt,
      bareKey.iv,
      options
    )
    const account: Account = {
      pubAddr: keyObject.address,
      checksumAddr: ethers.utils.getAddress(keyObject.address)
    }
    event.accountCreated.fire({
      successMsg: `New account created: 0x${keyObject.address as string}`,
      success: true
    })
    logger.log(JSON.stringify(account))

    if (!fs.existsSync(`${path}/keystore`)) {
      fs.mkdirSync(`${path}/keystore`)
    }
    keythereum.exportToFile(keyObject, `${path}/keystore`)
    listAddresses(context, path).then((addresses: string[]) => {
      event.updateAccountList.fire(addresses)
    }).catch((error: any) => logger.error(error))
    return keyObject.address
  } catch (error) {
    event.accountCreated.fire({ error, success: false })
  }
}

// Delete privateKey against address
const deleteKeyPair: any = async (context: vscode.ExtensionContext) => {
  try {
    const pubkeyInp: InputBoxOptions = {
      ignoreFocusOut: true,
      placeHolder: 'Public key'
    }
    const publicKey = await window.showInputBox(pubkeyInp)
    if (publicKey === undefined) {
      logger.log('Please input public address!')
      return
    }
    fs.readdir(`${context.extensionPath}/keystore`, (err, files) => {
      if (err != null) throw new Error(`Unable to scan directory: ${err.message}`)

      files.forEach((file) => {
        if (file.includes(publicKey.replace('0x', ''))) {
          fs.unlinkSync(`${context.extensionPath}/keystore/${file}`)
          listAddresses(context, context.extensionPath)
            .catch((error: any) => {
              logger.error(error)
            })
          logger.log('Account deleted!')
        }
      })
    })
  } catch (error) {
    logger.error(error)
  }
}

// Import Key pair
const importKeyPair: any = async (context: vscode.ExtensionContext) => {
  try {
    const options: vscode.OpenDialogOptions = {
      canSelectMany: false,
      openLabel: 'Open',
      filters: {
        'All files': ['*']
      }
    }

    const addresses = await listAddresses(context, context.extensionPath)

    await vscode.window.showOpenDialog(options).then((fileUri) => {
      if ((fileUri?.[0]) != null) {
        const filename = fileUri[0].fsPath.replace(/^.*[\\/]/, '')
        const arrFilePath = fileUri[0].fsPath.split('\\')
        const file = arrFilePath[arrFilePath.length - 1]
        const arr = file.split('--')
        const address = ethers.utils.getAddress(`0x${arr[arr.length - 1]}`)

        const already = addresses.find(
          (element: string) => ethers.utils.getAddress(element) === address
        )

        if (already !== undefined) {
          logger.log(`Account ${address} is already exist.`)
        } else {
          fs.copyFile(
            fileUri[0].fsPath,
            `${context.extensionPath}/keystore/${filename}`,
            (err) => {
              if (err != null) throw err
            }
          )

          logger.success(`Account ${address} is successfully imported!`)
          listAddresses(context, context.extensionPath)
            .catch((error: any) => {
              logger.error(error)
            })
        }
      }
    })
  } catch (error) {
    logger.error(error)
  }
}

// Extract privateKey against address
const extractPvtKey: any = async (keyStorePath: string, address: string) => {
  try {
    const pwdInpOpt: vscode.InputBoxOptions = {
      ignoreFocusOut: true,
      password: true,
      placeHolder: 'Password'
    }
    const password = await window.showInputBox(pwdInpOpt)

    const keyObject = keythereum.importFromFile(address, keyStorePath)
    return keythereum.recover(Buffer.from(password ?? '', 'utf-8'), keyObject)
  } catch (e) {
    throw new Error(
      "Password is wrong or such address doesn't exist in wallet lists"
    )
  }
}

const exportKeyPair: any = async (context: vscode.ExtensionContext) => {
  try {
    const addresses = await listAddresses(context, context.extensionPath)

    const quickPick = window.createQuickPick()

    quickPick.items = addresses.map((account: any) => ({
      label: account,
      description: (isTestingNetwork(context) === true)
        ? getSelectedNetwork(context)
        : 'Local account'
    }))

    quickPick.onDidChangeActive(() => {
      quickPick.placeholder = 'Select account'
    })

    quickPick.onDidChangeSelection((selection) => {
      if (selection[0] != null) {
        const { label } = selection[0]
        const files = fs.readdirSync(`${context.extensionPath}/keystore`)
        const address = label.slice(2, label.length)
        const selectedFile = files.filter((file: string) => {
          return file.includes(address)
        })[0]

        const options: vscode.OpenDialogOptions = {
          canSelectMany: false,
          canSelectFolders: true,
          openLabel: 'Save',
          filters: {
            'All files': ['*']
          }
        }

        void vscode.window.showOpenDialog(options).then((fileUri) => {
          if (fileUri?.[0] != null) {
            logger.log(
              'path: ',
              `${fileUri[0].fsPath}\\${selectedFile}\\${selectedFile}`
            )
            fs.copyFile(
              `${context.extensionPath}\\keystore\\${selectedFile}`,
              `${fileUri[0].fsPath}\\${selectedFile}`,
              (err) => {
                if (err != null) throw err
              }
            )

            logger.success(`Account ${address} is successfully exported!`)
          }
        })
        quickPick.dispose()
      }
    })

    quickPick.onDidHide(() => { quickPick.dispose() })
    quickPick.show()
  } catch (error) {
    logger.error(error)
  }
}

const selectAccount: any = async (context: vscode.ExtensionContext) => {
  const addresses = await listAddresses(context, context.extensionPath)

  const quickPick = window.createQuickPick()

  if (addresses.length === 0) {
    logger.log('No account found. Please create account first.')
    return
  }

  quickPick.items = addresses.map((account: any) => ({
    label: account,
    description: (isTestingNetwork(context) === true)
      ? getSelectedNetwork(context)
      : 'Local account'
  }))

  quickPick.onDidChangeActive(() => {
    quickPick.placeholder = 'Select account'
  })

  quickPick.onDidChangeSelection((selection) => {
    if (selection[0] != null) {
      const { label } = selection[0]
      void context.workspaceState.update('account', label)

      event.account.fire(label)

      logger.success(`Account ${label} is selected.`)
      logger.success(
        `You can see detail of this account here. ${getSelectedNetConf(context).blockScanner
        }/address/${label}`
      )
      quickPick.dispose()
    }
  })

  quickPick.onDidHide(() => { quickPick.dispose() })
  quickPick.show()
}

export {
  listAddresses,
  createKeyPair,
  exportKeyPair,
  deleteKeyPair,
  extractPvtKey,
  selectAccount,
  importKeyPair
}
