/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs'
import {
  ALL_EVENTS,
  beginSessionTransaction,
  clear,
  countCharacters,
  CountKind,
  createSession,
  createSimpleFileLogger,
  createViewport,
  del,
  destroySession,
  edit,
  EditorClient,
  endSessionTransaction,
  EventSubscriptionRequest,
  getByteOrderMark,
  getClient,
  getClientVersion,
  getComputedFileSize,
  getContentType,
  getCounts,
  getLanguage,
  getLogger,
  getServerHeartbeat,
  getServerInfo,
  getSessionCount,
  getViewportData,
  IOFlags,
  IServerInfo,
  modifyViewport,
  numAscii,
  profileSession,
  redo,
  replaceOneSession,
  saveSession,
  SaveStatus,
  searchSession,
  setAutoFixViewportDataLength,
  setLogger,
  startServer,
  stopServerUsingPID,
  undo,
  ViewportDataResponse,
  ViewportEvent,
  ViewportEventKind,
} from '@omega-edit/client'
import path from 'path'
import XDGAppPaths from 'xdg-app-paths'
import assert from 'assert'
import { SvelteWebviewInitializer } from './svelteWebviewInitializer'
import {
  EditorMessage,
  MessageCommand,
  MessageLevel,
} from '../svelte/src/utilities/message'
import {
  EditByteModes,
  VIEWPORT_CAPACITY_MAX,
} from '../svelte/src/stores/configuration'
import net from 'net'
import * as vscode from 'vscode'
import os from 'os'
import {
  HeartbeatInfo,
  IHeartbeatInfo,
} from './include/server/heartbeat/HeartBeatInfo'
import { ServerInfo } from './include/server/ServerInfo'
import { extractDaffodilEvent } from '../daffodilDebugger/daffodil'

// *****************************************************************************
// global constants
// *****************************************************************************

export const DATA_EDITOR_COMMAND: string = 'extension.data.edit'
export const OMEGA_EDIT_HOST: string = '127.0.0.1'
export const SERVER_START_TIMEOUT: number = 15 // in seconds
export const APP_DATA_PATH: string = XDGAppPaths({ name: 'omega_edit' }).data()

// *****************************************************************************
// file-scoped constants
// *****************************************************************************

const DEFAULT_OMEGA_EDIT_PORT: number = 9000
const HEARTBEAT_INTERVAL_MS: number = 1000 // 1 second (1000 ms)
const MAX_LOG_FILES: number = 5 // Maximum number of log files to keep TODO: make this configurable
const OMEGA_EDIT_MAX_PORT: number = 65535
const OMEGA_EDIT_MIN_PORT: number = 1024

// *****************************************************************************
// file-scoped variables
// *****************************************************************************

let activeSessions: string[] = []
let checkpointPath: string = ''
let client: EditorClient
let getHeartbeatIntervalId: NodeJS.Timeout | number | undefined = undefined
let heartbeatInfo: IHeartbeatInfo = new HeartbeatInfo()
let serverInfo: IServerInfo = new ServerInfo()
let omegaEditPort: number = 0

// *****************************************************************************
// exported functions
// *****************************************************************************

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      DATA_EDITOR_COMMAND,
      async (fileToEdit: string = '') => {
        return await createDataEditorWebviewPanel(ctx, fileToEdit)
      }
    )
  )
}

// *****************************************************************************
// exported class
// *****************************************************************************

export class DataEditorClient implements vscode.Disposable {
  public panel: vscode.WebviewPanel
  private svelteWebviewInitializer: SvelteWebviewInitializer
  private displayState: DisplayState
  private currentViewportId: string
  private fileToEdit: string = ''
  private omegaSessionId = ''
  private sendHeartbeatIntervalId: NodeJS.Timeout | number | undefined =
    undefined
  constructor(
    protected context: vscode.ExtensionContext,
    private view: string,
    title: string,
    fileToEdit: string = ''
  ) {
    const column =
      fileToEdit !== '' ? vscode.ViewColumn.Two : vscode.ViewColumn.Active
    this.panel = vscode.window.createWebviewPanel(this.view, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    })

    this.context.subscriptions.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(async (e) => {
        const debugEvent = e
        const eventAsEditorMessage = extractDaffodilEvent(debugEvent)
        if (eventAsEditorMessage === undefined) return

        const forwardAs = eventAsEditorMessage.asEditorMessage()

        await this.panel.webview.postMessage(forwardAs)
      })
    )

    this.panel.webview.onDidReceiveMessage(this.messageReceiver, this)
    this.svelteWebviewInitializer = new SvelteWebviewInitializer(context)
    this.svelteWebviewInitializer.initialize(this.view, this.panel.webview)
    this.currentViewportId = ''
    this.fileToEdit = fileToEdit
    this.displayState = new DisplayState(this.panel)
  }

  async dispose(): Promise<void> {
    if (this.sendHeartbeatIntervalId) {
      clearInterval(this.sendHeartbeatIntervalId)
      this.sendHeartbeatIntervalId = undefined
    }

    // destroy the session and remove it from the list of active sessions
    removeActiveSession(await destroySession(this.omegaSessionId))
    this.panel.dispose()
  }

  show(): void {
    this.panel.reveal()
  }

  public async initialize() {
    if (this.fileToEdit !== '') {
      await this.setupDataEditor()
    } else {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select',
        canSelectFiles: true,
        canSelectFolders: false,
      })
      if (fileUri && fileUri[0]) {
        this.fileToEdit = fileUri[0].fsPath
        this.panel.title = path.basename(this.fileToEdit)
        await this.setupDataEditor()
      }
    }
    // send and initial heartbeat, then send the heartbeat to the webview at regular intervals
    await this.sendHeartbeat()
    this.sendHeartbeatIntervalId = setInterval(() => {
      this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private async setupDataEditor() {
    assert(
      checkpointPath && checkpointPath.length > 0,
      'checkpointPath is not set'
    )

    let data = {
      byteOrderMark: '',
      changeCount: 0,
      computedFileSize: 0,
      diskFileSize: 0,
      fileName: this.fileToEdit,
      language: '',
      type: '',
      undoCount: 0,
    }

    // create a session and capture the session id, content type, and file size
    try {
      const createSessionResponse = await createSession(
        this.fileToEdit,
        undefined,
        checkpointPath
      )
      this.omegaSessionId = createSessionResponse.getSessionId()
      assert(this.omegaSessionId.length > 0, 'omegaSessionId is not set')
      addActiveSession(this.omegaSessionId)

      data.diskFileSize = data.computedFileSize =
        createSessionResponse.hasFileSize()
          ? (createSessionResponse.getFileSize() as number)
          : 0

      const contentTypeResponse = await getContentType(
        this.omegaSessionId,
        0,
        Math.min(1024, data.computedFileSize)
      )
      data.type = contentTypeResponse.getContentType()
      assert(data.type.length > 0, 'contentType is not set')

      const byteOrderMarkResponse = await getByteOrderMark(
        this.omegaSessionId,
        0
      )
      data.byteOrderMark = byteOrderMarkResponse.getByteOrderMark()
      assert(data.byteOrderMark.length > 0, 'byteOrderMark is not set')

      const languageResponse = await getLanguage(
        this.omegaSessionId,
        0,
        Math.min(1024, data.computedFileSize),
        data.byteOrderMark
      )
      data.language = languageResponse.getLanguage()
      assert(data.language.length > 0, 'language is not set')

      data.diskFileSize = data.computedFileSize =
        createSessionResponse.hasFileSize()
          ? (createSessionResponse.getFileSize() as number)
          : 0
    } catch {
      const msg = `Failed to create session for ${this.fileToEdit}`
      getLogger().error({
        err: {
          msg: msg,
          stack: new Error().stack,
        },
      })
      vscode.window.showErrorMessage(msg)
    }

    // create the viewport
    try {
      const viewportDataResponse = await createViewport(
        undefined,
        this.omegaSessionId,
        0,
        VIEWPORT_CAPACITY_MAX,
        false
      )
      this.currentViewportId = viewportDataResponse.getViewportId()
      assert(this.currentViewportId.length > 0, 'currentViewportId is not set')
      await viewportSubscribe(this.panel, this.currentViewportId)
      await sendViewportRefresh(this.panel, viewportDataResponse)
    } catch {
      const msg = `Failed to create viewport for ${this.fileToEdit}`
      getLogger().error({
        err: {
          msg: msg,
          stack: new Error().stack,
        },
      })
      vscode.window.showErrorMessage(msg)
    }

    // send the initial file info to the webview
    await this.panel.webview.postMessage({
      command: MessageCommand.fileInfo,
      data: data,
    })
  }

  private async sendHeartbeat() {
    await this.panel.webview.postMessage({
      command: MessageCommand.heartbeat,
      data: {
        latency: heartbeatInfo.latency,
        omegaEditPort: heartbeatInfo.omegaEditPort,
        serverCpuLoadAverage: heartbeatInfo.serverCpuLoadAverage,
        serverUptime: heartbeatInfo.serverUptime,
        serverUsedMemory: heartbeatInfo.serverUsedMemory,
        sessionCount: heartbeatInfo.sessionCount,
        serverInfo: {
          omegaEditPort: heartbeatInfo.omegaEditPort,
          serverVersion: heartbeatInfo.serverInfo.serverVersion,
          serverHostname: heartbeatInfo.serverInfo.serverHostname,
          serverProcessId: heartbeatInfo.serverInfo.serverProcessId,
          jvmVersion: heartbeatInfo.serverInfo.jvmVersion,
          jvmVendor: heartbeatInfo.serverInfo.jvmVendor,
          jvmPath: heartbeatInfo.serverInfo.jvmPath,
          availableProcessors: heartbeatInfo.serverInfo.availableProcessors,
        },
      },
    })
  }

  private async sendChangesInfo() {
    // get the counts from the server
    const counts = await getCounts(this.omegaSessionId, [
      CountKind.COUNT_COMPUTED_FILE_SIZE,
      CountKind.COUNT_CHANGE_TRANSACTIONS,
      CountKind.COUNT_UNDO_TRANSACTIONS,
    ])

    // accumulate the counts into a single object
    let data = {
      fileName: this.fileToEdit,
      computedFileSize: 0,
      changeCount: 0,
      undoCount: 0,
    }
    counts.forEach((count) => {
      switch (count.getKind()) {
        case CountKind.COUNT_COMPUTED_FILE_SIZE:
          data.computedFileSize = count.getCount()
          break
        case CountKind.COUNT_CHANGE_TRANSACTIONS:
          data.changeCount = count.getCount()
          break
        case CountKind.COUNT_UNDO_TRANSACTIONS:
          data.undoCount = count.getCount()
          break
      }
    })

    // send the accumulated counts to the webview
    await this.panel.webview.postMessage({
      command: MessageCommand.fileInfo,
      data: data,
    })
  }

  // handle messages from the webview
  private async messageReceiver(message: EditorMessage) {
    switch (message.command) {
      case MessageCommand.showMessage:
        switch (message.data.messageLevel as MessageLevel) {
          case MessageLevel.Error:
            vscode.window.showErrorMessage(message.data.message)
            break
          case MessageLevel.Info:
            vscode.window.showInformationMessage(message.data.message)
            break
          case MessageLevel.Warn:
            vscode.window.showWarningMessage(message.data.message)
            break
        }
        break

      case MessageCommand.scrollViewport:
        await this.scrollViewport(
          this.panel,
          this.currentViewportId,
          message.data.scrollOffset,
          message.data.bytesPerRow
        )
        break

      case MessageCommand.editorOnChange:
        {
          this.displayState.editorEncoding = message.data.encoding
          const encodeDataAs =
            message.data.editMode === EditByteModes.Single
              ? 'hex'
              : this.displayState.editorEncoding

          if (
            message.data.selectionData &&
            message.data.selectionData.length > 0
          ) {
            await this.panel.webview.postMessage({
              command: MessageCommand.editorOnChange,
              display: dataToEncodedStr(
                Buffer.from(message.data.selectionData),
                encodeDataAs
              ),
            })
          }
        }
        break

      case MessageCommand.applyChanges:
        await edit(
          this.omegaSessionId,
          message.data.offset,
          message.data.originalSegment,
          message.data.editedSegment
        )
        await this.sendChangesInfo()
        break

      case MessageCommand.undoChange:
        await undo(this.omegaSessionId)
        await this.sendChangesInfo()
        this.panel.webview.postMessage({
          command: MessageCommand.clearChanges,
        })
        break

      case MessageCommand.redoChange:
        await redo(this.omegaSessionId)
        await this.sendChangesInfo()
        this.panel.webview.postMessage({
          command: MessageCommand.clearChanges,
        })
        break

      case MessageCommand.profile:
        {
          const startOffset: number = message.data.startOffset
          const length: number = message.data.length
          const byteProfile: number[] = await profileSession(
            this.omegaSessionId,
            startOffset,
            length
          )
          const characterCount = await countCharacters(
            this.omegaSessionId,
            startOffset,
            length
          )
          const contentTypeResponse = await getContentType(
            this.omegaSessionId,
            startOffset,
            length
          )
          const languageResponse = await getLanguage(
            this.omegaSessionId,
            startOffset,
            length,
            characterCount.getByteOrderMark()
          )
          await this.panel.webview.postMessage({
            command: MessageCommand.profile,
            data: {
              startOffset: startOffset,
              length: length,
              byteProfile: byteProfile,
              numAscii: numAscii(byteProfile),
              language: languageResponse.getLanguage(),
              contentType: contentTypeResponse.getContentType(),
              characterCount: {
                byteOrderMark: characterCount.getByteOrderMark(),
                byteOrderMarkBytes: characterCount.getByteOrderMarkBytes(),
                singleByteCount: characterCount.getSingleByteChars(),
                doubleByteCount: characterCount.getDoubleByteChars(),
                tripleByteCount: characterCount.getTripleByteChars(),
                quadByteCount: characterCount.getQuadByteChars(),
                invalidBytes: characterCount.getInvalidBytes(),
              },
            },
          })
        }
        break

      case MessageCommand.clearChanges:
        if (
          (await vscode.window.showInformationMessage(
            'Are you sure you want to revert all changes?',
            { modal: true },
            'Yes',
            'No'
          )) === 'Yes'
        ) {
          await clear(this.omegaSessionId)
          await this.sendChangesInfo()
          this.panel.webview.postMessage({
            command: MessageCommand.clearChanges,
          })
        }
        break

      case MessageCommand.save:
        await this.saveFile(this.fileToEdit)
        break

      case MessageCommand.saveAs:
        {
          const uri = await vscode.window.showSaveDialog({
            title: 'Save Session',
            saveLabel: 'Save',
          })
          if (uri && uri.fsPath) {
            await this.saveFile(uri.fsPath)
          }
        }
        break

      case MessageCommand.saveSegment:
        {
          const uri = await vscode.window.showSaveDialog({
            title: 'Save Segment',
            saveLabel: 'Save',
          })
          if (uri && uri.fsPath) {
            await this.saveFileSegment(
              uri.fsPath,
              message.data.offset,
              message.data.length
            )
          }
        }
        break

      case MessageCommand.requestEditedData:
        {
          const [selectionData, selectionDisplay] = fillRequestData(message)

          await this.panel.webview.postMessage({
            command: MessageCommand.requestEditedData,
            data: {
              data: Uint8Array.from(selectionData),
              dataDisplay: selectionDisplay,
            },
          })
        }
        break

      case MessageCommand.replace:
        {
          const searchDataBytes = encodedStrToData(
            message.data.searchData,
            message.data.encoding
          )
          const replaceDataBytes = encodedStrToData(
            message.data.replaceData,
            message.data.encoding
          )
          const nextOffset = await replaceOneSession(
            this.omegaSessionId,
            searchDataBytes,
            replaceDataBytes,
            message.data.caseInsensitive,
            message.data.isReverse,
            message.data.searchOffset,
            message.data.searchLength,
            message.data.overwriteOnly
          )
          if (nextOffset === -1) {
            vscode.window.showErrorMessage('No replacement took place')
          } else {
            await this.sendChangesInfo()
          }
          await this.panel.webview.postMessage({
            command: MessageCommand.replaceResults,
            data: {
              replacementsCount: nextOffset === -1 ? 0 : 1,
              nextOffset: nextOffset,
              searchDataBytesLength: searchDataBytes.length,
              replaceDataBytesLength: replaceDataBytes.length,
            },
          })
        }
        break

      case MessageCommand.search:
        {
          const searchDataBytes = encodedStrToData(
            message.data.searchData,
            message.data.encoding
          )
          const searchResults = await searchSession(
            this.omegaSessionId,
            searchDataBytes,
            message.data.caseInsensitive,
            message.data.isReverse,
            message.data.searchOffset,
            message.data.searchLength,
            message.data.limit + 1
          )
          if (searchResults.length === 0) {
            vscode.window.showInformationMessage(
              `No more matches found for '${message.data.searchData}'`
            )
          }
          let overflow = false
          if (searchResults.length > message.data.limit) {
            overflow = true
            searchResults.pop()
          }
          await this.panel.webview.postMessage({
            command: MessageCommand.searchResults,
            data: {
              searchResults: searchResults,
              searchDataBytesLength: searchDataBytes.length,
              overflow: overflow,
            },
          })
        }
        break
    }
  }

  private async saveFileSegment(
    fileToSave: string,
    offset: number,
    length: number
  ) {
    // if the file to save is the same as the file being edited then we can save the file with a single transaction to
    // trim the file to contain only the desired segment, preserving session state
    if (this.fileToEdit === fileToSave) {
      const computedFileSize = await getComputedFileSize(this.omegaSessionId)
      if (offset === 0) {
        if (offset + length !== computedFileSize) {
          // delete from length to the end of the file
          await del(this.omegaSessionId, length, computedFileSize - length)
          await this.sendChangesInfo()
        }
      } else if (offset + length === computedFileSize) {
        // delete from 0 to offset
        await del(this.omegaSessionId, 0, offset)
        await this.sendChangesInfo()
      } else {
        // delete from length to the end of the file and from 0 to offset in a single transaction
        await beginSessionTransaction(this.omegaSessionId)
        await del(
          this.omegaSessionId,
          offset + length,
          computedFileSize - length
        )
        await del(this.omegaSessionId, 0, offset)
        await endSessionTransaction(this.omegaSessionId)
        await this.sendChangesInfo()
      }
      // save the segment to the file using the typical save method
      await this.saveFile(fileToSave)
    } else {
      let saved = false
      let cancelled = false

      // try to save the file with overwrite
      const saveResponse = await saveSession(
        this.omegaSessionId,
        fileToSave,
        IOFlags.IO_FLG_OVERWRITE,
        offset,
        length
      )
      if (saveResponse.getSaveStatus() === SaveStatus.MODIFIED) {
        // the file was modified since the session was created, query user to overwrite the modified file
        if (
          (await vscode.window.showInformationMessage(
            'File has been modified since being opened overwrite the file anyway?',
            { modal: true },
            'Yes',
            'No'
          )) === 'Yes'
        ) {
          // the user decided to overwrite the file, try to save again with force overwrite
          const saveResponse2 = await saveSession(
            this.omegaSessionId,
            fileToSave,
            IOFlags.IO_FLG_FORCE_OVERWRITE,
            offset,
            length
          )
          saved = saveResponse2.getSaveStatus() === SaveStatus.SUCCESS
        } else {
          cancelled = true
        }
      } else {
        saved = saveResponse.getSaveStatus() === SaveStatus.SUCCESS
      }

      if (saved) {
        vscode.window.showInformationMessage(`Saved: ${this.fileToEdit}`)
      } else if (cancelled) {
        vscode.window.showInformationMessage(`Cancelled save: ${fileToSave}`)
      } else {
        vscode.window.showErrorMessage(`Failed to save: ${fileToSave}`)
      }
    }
  }

  private async saveFile(fileToSave: string) {
    let saved = false
    let cancelled = false

    // try to save the file with overwrite
    const saveResponse = await saveSession(
      this.omegaSessionId,
      fileToSave,
      IOFlags.IO_FLG_OVERWRITE
    )
    if (saveResponse.getSaveStatus() === SaveStatus.MODIFIED) {
      // the file was modified since the session was created, query user to overwrite the modified file
      if (
        (await vscode.window.showInformationMessage(
          'File has been modified since being opened overwrite the file anyway?',
          { modal: true },
          'Yes',
          'No'
        )) === 'Yes'
      ) {
        // the user decided to overwrite the file, try to save again with force overwrite
        const saveResponse2 = await saveSession(
          this.omegaSessionId,
          fileToSave,
          IOFlags.IO_FLG_FORCE_OVERWRITE
        )
        saved = saveResponse2.getSaveStatus() === SaveStatus.SUCCESS
      } else {
        cancelled = true
      }
    } else {
      saved = saveResponse.getSaveStatus() === SaveStatus.SUCCESS
    }

    if (saved) {
      this.fileToEdit = fileToSave
      const fileSize = await getComputedFileSize(this.omegaSessionId)
      await this.panel.webview.postMessage({
        command: MessageCommand.fileInfo,
        data: {
          computedFileSize: fileSize,
          diskFileSize: fileSize,
          fileName: fileToSave,
        },
      })
      vscode.window.showInformationMessage(`Saved: ${fileToSave}`)
    } else if (cancelled) {
      vscode.window.showInformationMessage(`Cancelled save: ${fileToSave}`)
    } else {
      vscode.window.showErrorMessage(`Failed to save: ${fileToSave}`)
    }
  }

  private async scrollViewport(
    panel: vscode.WebviewPanel,
    viewportId: string,
    offset: number,
    bytesPerRow: number
  ) {
    // start of the row containing the offset, making sure the offset is never negative
    const startOffset = Math.max(0, offset - (offset % bytesPerRow))
    try {
      await sendViewportRefresh(
        panel,
        await modifyViewport(viewportId, startOffset, VIEWPORT_CAPACITY_MAX)
      )
    } catch {
      const msg = `Failed to scroll viewport ${viewportId} to offset ${startOffset}`
      getLogger().error({
        err: {
          msg: msg,
          stack: new Error().stack,
        },
      })
      vscode.window.showErrorMessage(msg)
    }
  }
}

// *****************************************************************************
// file-scoped functions
// *****************************************************************************
function cleanFileToEditStr(fileToEdit: string): string {
  let rootPath = vscode.workspace.workspaceFolders
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : vscode.Uri.parse('').fsPath
  fileToEdit = fileToEdit.includes('${workspaceFolder}')
    ? fileToEdit.replace('${workspaceFolder}', rootPath)
    : fileToEdit
  return fileToEdit
}
async function createDataEditorWebviewPanel(
  ctx: vscode.ExtensionContext,
  fileToEdit: string
): Promise<DataEditorClient> {
  // make sure the app data path exists
  fs.mkdirSync(APP_DATA_PATH, { recursive: true })
  assert(fs.existsSync(APP_DATA_PATH), 'app data path does not exist')

  // make sure the omega edit port is configured
  configureOmegaEditPort()
  assert(omegaEditPort > 0, 'omega edit port not configured')

  // only start up the server if one is not already running
  if (!(await checkServerListening(omegaEditPort, OMEGA_EDIT_HOST))) {
    await setupLogging()
    setAutoFixViewportDataLength(true)
    await serverStart()
    client = await getClient(omegaEditPort, OMEGA_EDIT_HOST)
    assert(
      await checkServerListening(omegaEditPort, OMEGA_EDIT_HOST),
      'server not listening'
    )
    // initialize the first server heartbeat
    await getHeartbeat()
    assert(
      heartbeatInfo.serverInfo.serverVersion.length > 0,
      'heartbeat did not receive a server version'
    )
  }
  fileToEdit = cleanFileToEditStr(fileToEdit)
  const dataEditorView = new DataEditorClient(
    ctx,
    'dataEditor',
    'Data Editor',
    fileToEdit
  )

  await dataEditorView.initialize()

  dataEditorView.panel.onDidDispose(
    async () => {
      await dataEditorView.dispose()
      // stop the server if the session count is zero
      const sessionCount = await getSessionCount()
      if (sessionCount === 0) {
        assert(activeSessions.length === 0)

        // stop the server
        await serverStop()
      }
    },
    undefined,
    ctx.subscriptions
  )

  dataEditorView.show()
  return dataEditorView
}

function rotateLogFiles(logFile: string): void {
  interface LogFile {
    path: string
    ctime: Date
  }

  assert(
    MAX_LOG_FILES > 0,
    'Maximum number of log files must be greater than 0'
  )

  if (fs.existsSync(logFile)) {
    const logDir = path.dirname(logFile)
    const logFileName = path.basename(logFile)

    // Get list of existing log files
    const logFiles: LogFile[] = fs
      .readdirSync(logDir)
      .filter((file) => file.startsWith(logFileName) && file !== logFileName)
      .map((file) => ({
        path: path.join(logDir, file),
        ctime: fs.statSync(path.join(logDir, file)).ctime,
      }))
      .sort((a, b) => b.ctime.getTime() - a.ctime.getTime())

    // Delete oldest log files if maximum number of log files is exceeded
    while (logFiles.length >= MAX_LOG_FILES) {
      const fileToDelete = logFiles.pop() as LogFile
      fs.unlinkSync(fileToDelete.path)
    }

    // Rename current log file with timestamp and create a new empty file
    const timestamp = new Date().toISOString().replace(/:/g, '-')
    fs.renameSync(logFile, path.join(logDir, `${logFileName}.${timestamp}`))
  }
}

function getPidFile(serverPort: number): string {
  return path.join(APP_DATA_PATH, `serv-${serverPort}.pid`)
}

function configureOmegaEditPort(): void {
  if (omegaEditPort === 0) {
    /**
     * Loop through all available configurations inside of launch.json
     * If dataEditor.omegaEditPort is set then we update the port
     *   NOTE: Whichever configuration sets the last will be the value used
     */
    vscode.workspace
      .getConfiguration(
        'launch',
        vscode.workspace.workspaceFolders
          ? vscode.workspace.workspaceFolders[0].uri
          : vscode.Uri.parse('')
      )
      .get<Array<Object>>('configurations')
      ?.forEach((config) => {
        omegaEditPort =
          'dataEditor' in config && 'port' in (config['dataEditor'] as object)
            ? ((config['dataEditor'] as object)['port'] as number)
            : omegaEditPort
      })

    omegaEditPort =
      omegaEditPort !== 0 ? omegaEditPort : DEFAULT_OMEGA_EDIT_PORT

    if (
      omegaEditPort <= OMEGA_EDIT_MIN_PORT ||
      omegaEditPort > OMEGA_EDIT_MAX_PORT
    ) {
      const message = `Invalid port ${omegaEditPort} for Ωedit. Use a port between ${OMEGA_EDIT_MIN_PORT} and ${OMEGA_EDIT_MAX_PORT}`
      omegaEditPort = 0
      throw new Error(message)
    }
    // Set the checkpoint path to be used by Ωedit sessions
    checkpointPath = path.join(APP_DATA_PATH, `.checkpoint-${omegaEditPort}`)
    if (!fs.existsSync(checkpointPath)) {
      fs.mkdirSync(checkpointPath, { recursive: true })
    }
    assert(fs.existsSync(checkpointPath), 'checkpoint path does not exist')
    assert(omegaEditPort !== 0, 'omegaEditPort is not set')
  }
}

async function setupLogging(): Promise<void> {
  const config = vscode.workspace.getConfiguration('dataEditor')
  const logFile = config
    .get<string>(
      'logFile',
      '${workspaceFolder}/dataEditor-${omegaEditPort}.log'
    )
    ?.replace('${workspaceFolder}', APP_DATA_PATH)
    .replace('${omegaEditPort}', omegaEditPort.toString())
  const logLevel =
    process.env.OMEGA_EDIT_CLIENT_LOG_LEVEL ||
    process.env.OMEGA_EDIT_LOG_LEVEL ||
    config.get<string>('logLevel', 'info')
  rotateLogFiles(logFile)
  setLogger(createSimpleFileLogger(logFile, logLevel))
  vscode.window.showInformationMessage(`Logging (${logLevel}) to '${logFile}'`)
}

async function sendViewportRefresh(
  panel: vscode.WebviewPanel,
  viewportDataResponse: ViewportDataResponse
): Promise<void> {
  await panel.webview.postMessage({
    command: MessageCommand.viewportRefresh,
    data: {
      viewportId: viewportDataResponse.getViewportId(),
      viewportOffset: viewportDataResponse.getOffset(),
      viewportLength: viewportDataResponse.getLength(),
      viewportFollowingByteCount: viewportDataResponse.getFollowingByteCount(),
      viewportData: viewportDataResponse.getData_asU8(),
      viewportCapacity: VIEWPORT_CAPACITY_MAX,
    },
  })
}

/**
 * Subscribe to all events for a given viewport so the editor gets refreshed when changes to the viewport occur
 * @param panel webview panel to send updates to
 * @param viewportId id of the viewport to subscribe to
 */
async function viewportSubscribe(
  panel: vscode.WebviewPanel,
  viewportId: string
) {
  // subscribe to all viewport events
  client
    .subscribeToViewportEvents(
      new EventSubscriptionRequest()
        .setId(viewportId)
        .setInterest(ALL_EVENTS & ~ViewportEventKind.VIEWPORT_EVT_MODIFY)
    )
    .on('data', async (event: ViewportEvent) => {
      getLogger().debug({
        viewportId: event.getViewportId(),
        event: event.getViewportEventKind(),
      })
      await sendViewportRefresh(panel, await getViewportData(viewportId))
    })
    .on('error', (err) => {
      // Call cancelled thrown sometimes when server is shutdown
      if (
        !err.message.includes('Call cancelled') &&
        !err.message.includes('UNAVAILABLE')
      )
        throw err
    })
}

class DisplayState {
  public editorEncoding: BufferEncoding
  public colorThemeKind: vscode.ColorThemeKind
  private panel: vscode.WebviewPanel

  constructor(editorPanel: vscode.WebviewPanel) {
    this.editorEncoding = 'hex'
    this.colorThemeKind = vscode.window.activeColorTheme.kind
    this.panel = editorPanel

    vscode.window.onDidChangeActiveColorTheme(async (event) => {
      this.colorThemeKind = event.kind
      await this.sendUIThemeUpdate()
    })
    this.sendUIThemeUpdate()
  }

  private sendUIThemeUpdate() {
    return this.panel.webview.postMessage({
      command: MessageCommand.setUITheme,
      theme: this.colorThemeKind,
    })
  }
}

function fillRequestData(message: EditorMessage): [Buffer, string] {
  let selectionByteData: Buffer
  let selectionByteDisplay: string
  if (message.data.editMode === EditByteModes.Multiple) {
    selectionByteData = encodedStrToData(
      message.data.editedContent,
      message.data.encoding
    )
    selectionByteDisplay = dataToEncodedStr(
      selectionByteData,
      message.data.encoding
    )
  } else {
    selectionByteData =
      message.data.viewport === 'logical'
        ? encodedStrToData(message.data.editedContent, 'latin1')
        : Buffer.from([
            parseInt(message.data.editedContent, message.data.radix),
          ])

    selectionByteDisplay =
      message.data.viewport === 'logical'
        ? message.data.editedContent
        : dataToRadixStr(selectionByteData, message.data.radix)
  }

  return [selectionByteData, selectionByteDisplay]
}

function encodedStrToData(
  selectionEdits: string,
  selectionEncoding?: BufferEncoding
): Buffer {
  let selectionByteData: Buffer
  switch (selectionEncoding) {
    case 'hex':
      selectionByteData = Buffer.alloc(selectionEdits.length / 2)
      for (let i = 0; i < selectionEdits.length; i += 2) {
        selectionByteData[i / 2] = parseInt(selectionEdits.slice(i, i + 2), 16)
      }
      return selectionByteData
    case 'binary':
      selectionByteData = Buffer.alloc(selectionEdits.length / 8)
      for (let i = 0; i < selectionEdits.length; i += 8) {
        selectionByteData[i / 8] = parseInt(selectionEdits.slice(i, i + 8), 2)
      }
      return selectionByteData
    default:
      return Buffer.from(selectionEdits, selectionEncoding)
  }
}

function dataToEncodedStr(buffer: Buffer, encoding: BufferEncoding): string {
  return encoding === 'binary'
    ? dataToRadixStr(buffer, 2)
    : buffer.toString(encoding)
}

function dataToRadixStr(buffer: Buffer, radix: number): string {
  const padLen = radixBytePad(radix)
  let ret = ''
  for (let i = 0; i < buffer.byteLength; i++) {
    ret += buffer[i].toString(radix).padStart(padLen, '0')
  }
  return ret
}

function radixBytePad(radix: number): number {
  switch (radix) {
    case 2:
      return 8
    case 8:
      return 3
    case 10:
      return 3
    case 16:
      return 2
  }
  return 0
}

/**
 * Checks if a server is listening on a given port and host
 * @param port port to check
 * @param host host to check
 * @returns true if a server is listening on the given port and host, false otherwise
 */
function checkServerListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: net.Socket = new net.Socket()
    socket.setTimeout(2000) // set a 2-second timeout for the connection attempt
    socket.on('connect', () => {
      socket.destroy() // close the connection once connected
      resolve(true) // server is listening
    })
    socket.on('timeout', () => {
      socket.destroy() // close the connection on timeout
      resolve(false) // server is not listening
    })
    socket.on('error', () => {
      resolve(false) // server is not listening or an error occurred
    })
    socket.connect(port, host)
  })
}

/**
 * Removes a directory and all of its contents
 * @param dirPath path to directory to remove
 */
function removeDirectory(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = `${dirPath}/${file}`
      if (fs.lstatSync(curPath).isDirectory()) {
        // Recursively remove subdirectories
        removeDirectory(curPath)
      } else {
        // Delete file
        fs.unlinkSync(curPath)
      }
    })

    // Remove empty directory
    fs.rmdirSync(dirPath)
  }
}

async function serverStop() {
  const serverPidFile = getPidFile(omegaEditPort)
  if (fs.existsSync(serverPidFile)) {
    const pid = parseInt(fs.readFileSync(serverPidFile).toString())
    if (await stopServerUsingPID(pid)) {
      vscode.window.setStatusBarMessage(
        `Ωedit server stopped on port ${omegaEditPort} with PID ${pid}`,
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(true)
          }, 2000)
        })
      )
      removeDirectory(checkpointPath)
    } else {
      vscode.window.showErrorMessage(
        `Ωedit server on port ${omegaEditPort} with PID ${pid} failed to stop`
      )
    }
  }
}

function generateLogbackConfigFile(
  logFile: string,
  logLevel: string = 'INFO'
): string {
  const dirname = path.dirname(logFile)
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true })
  }
  logLevel = logLevel.toUpperCase()
  const logbackConfig = `<?xml version="1.0" encoding="UTF-8"?>\n
<configuration>
    <appender name="FILE" class="ch.qos.logback.core.FileAppender">
        <file>${logFile}</file>
        <encoder>
            <pattern>[%date{ISO8601}] [%level] [%logger] [%marker] [%thread] - %msg MDC: {%mdc}%n</pattern>
        </encoder>
    </appender>
    <root level="${logLevel}">
        <appender-ref ref="FILE" />
    </root>
</configuration>
`
  const logbackConfigFile = path.join(
    APP_DATA_PATH,
    `serv-${omegaEditPort}.logconf.xml`
  )
  rotateLogFiles(logFile)
  fs.writeFileSync(logbackConfigFile, logbackConfig)
  return logbackConfigFile // Return the path to the logback config file
}

function addActiveSession(sessionId: string): void {
  if (!activeSessions.includes(sessionId)) {
    activeSessions.push(sessionId)
    // scale the heartbeat interval based on the number of active sessions to reduce load on the server
    getHeartbeat().then(() => {
      if (getHeartbeatIntervalId) {
        clearInterval(getHeartbeatIntervalId)
      }
      getHeartbeatIntervalId = setInterval(async () => {
        await getHeartbeat()
      }, HEARTBEAT_INTERVAL_MS * activeSessions.length)
    })
  }
}

function removeActiveSession(sessionId: string): void {
  const index = activeSessions.indexOf(sessionId)
  if (index >= 0) {
    activeSessions.splice(index, 1)
    clearInterval(getHeartbeatIntervalId)
    getHeartbeatIntervalId = undefined
    if (activeSessions.length > 0) {
      // scale the heartbeat interval based on the number of active sessions
      getHeartbeat().then(() => {
        getHeartbeatIntervalId = setInterval(async () => {
          await getHeartbeat()
        }, HEARTBEAT_INTERVAL_MS * activeSessions.length)
      })
    }
  }
}

async function getHeartbeat() {
  assert(omegaEditPort > 0, `illegal Ωedit port ${omegaEditPort}`)
  const heartbeat = await getServerHeartbeat(
    activeSessions,
    HEARTBEAT_INTERVAL_MS
  )
  heartbeatInfo.omegaEditPort = omegaEditPort
  heartbeatInfo.latency = heartbeat.latency
  heartbeatInfo.serverCommittedMemory = heartbeat.serverCommittedMemory
  heartbeatInfo.serverCpuCount = heartbeat.serverCpuCount
  heartbeatInfo.serverCpuLoadAverage = heartbeat.serverCpuLoadAverage
  heartbeatInfo.serverMaxMemory = heartbeat.serverMaxMemory
  heartbeatInfo.serverTimestamp = heartbeat.serverTimestamp
  heartbeatInfo.serverUptime = heartbeat.serverUptime
  heartbeatInfo.serverUsedMemory = heartbeat.serverUsedMemory
  heartbeatInfo.sessionCount = heartbeat.sessionCount
  heartbeatInfo.serverInfo = serverInfo
}

async function serverStart() {
  await serverStop()
  const serverStartingText = `Ωedit server starting on port ${omegaEditPort}`
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  )
  statusBarItem.text = serverStartingText
  statusBarItem.show()

  let animationFrame = 0
  const animationInterval = 400 // ms per frame
  const animationFrames = ['', '.', '..', '...']
  const animationIntervalId = setInterval(() => {
    statusBarItem.text = `${serverStartingText} ${
      animationFrames[++animationFrame % animationFrames.length]
    }`
  }, animationInterval)
  const config = vscode.workspace.getConfiguration('dataEditor')
  const logLevel =
    process.env.OMEGA_EDIT_SERVER_LOG_LEVEL ||
    process.env.OMEGA_EDIT_LOG_LEVEL ||
    config.get<string>('logLevel', 'info')
  const logConfigFile = generateLogbackConfigFile(
    path.join(APP_DATA_PATH, `serv-${omegaEditPort}.log`),
    logLevel
  )
  if (!fs.existsSync(logConfigFile)) {
    clearInterval(animationIntervalId)
    statusBarItem.dispose()
    throw new Error(`Log config file '${logConfigFile}' not found`)
  }

  // Start the server and wait up to 10 seconds for it to start
  const serverPid = (await Promise.race([
    startServer(
      omegaEditPort,
      OMEGA_EDIT_HOST,
      getPidFile(omegaEditPort),
      logConfigFile
    ),
    new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject((): Error => {
          return new Error(
            `Server startup timed out after ${SERVER_START_TIMEOUT} seconds`
          )
        })
      }, SERVER_START_TIMEOUT * 1000)
    }),
  ])) as number | undefined
  clearInterval(animationIntervalId)
  if (serverPid === undefined || serverPid <= 0) {
    statusBarItem.dispose()
    throw new Error('Server failed to start or PID is invalid')
  }
  // this makes sure the server if fully online and ready to take requests
  statusBarItem.text = `Initializing Ωedit server on port ${omegaEditPort}`
  for (let i = 1; i <= 60; ++i) {
    try {
      await getServerInfo()
      break
    } catch (err) {
      statusBarItem.text = `Initializing Ωedit server on port ${omegaEditPort} (${i}/60)`
    }
    // wait 1 second before trying again
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(true)
      }, 1000)
    })
  }
  try {
    serverInfo = await getServerInfo()
  } catch (err) {
    statusBarItem.dispose()
    await serverStop()
    throw new Error('Server failed to initialize')
  }
  statusBarItem.text = `Ωedit server on port ${omegaEditPort} initialized`
  const serverVersion = serverInfo.serverVersion
  // if the OS is not Windows, check that the server PID matches the one started
  // NOTE: serverPid is the PID of the server wrapper script on Windows
  if (
    !os.platform().toLowerCase().startsWith('win') &&
    serverInfo.serverProcessId !== serverPid
  ) {
    statusBarItem.dispose()
    throw new Error(
      `server PID mismatch ${serverInfo.serverProcessId} != ${serverPid}`
    )
  }
  const clientVersion = getClientVersion()
  if (serverVersion !== clientVersion) {
    statusBarItem.dispose()
    throw new Error(
      `Server version ${serverVersion} and client version ${clientVersion} must match`
    )
  }
  // get an initial heartbeat
  await getHeartbeat()
  statusBarItem.text = `Ωedit server v${serverVersion} ready on port ${omegaEditPort} with PID ${serverInfo.serverProcessId}`
  setTimeout(() => {
    statusBarItem.dispose()
  }, 5000)
}
