/*
  Copyright 2022 Picovoice Inc.

  You may not use this file except in compliance with the license. A copy of the license is located in the "LICENSE"
  file accompanying this source.

  Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
  an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
  specific language governing permissions and limitations under the License.
*/

/* eslint camelcase: 0 */

import { Mutex } from 'async-mutex';

import {
  aligned_alloc_type,
  pv_free_type,
  buildWasm,
  arrayBufferToStringAtIndex,
  isAccessKeyValid,
  fromBase64,
  fromPublicDirectory,
} from '@picovoice/web-utils';

import { simd } from 'wasm-feature-detect';

import {
  PorcupineDetection,
  PorcupineKeyword,
  PorcupineOptions,
} from './types';

import { keywordsProcess } from './utils';
import { BuiltInKeyword } from './built_in_keywords';

/**
 * WebAssembly function types
 */

type pv_porcupine_init_type = (
  accessKey: number,
  modelPath: number,
  numKeywords: number,
  keywordPaths: number,
  sensitivities: number,
  object: number,
) => Promise<number>;
type pv_porcupine_process_type = (object: number, pcm: number, keywordIndex: number) => Promise<number>;
type pv_porcupine_delete_type = (object: number) => Promise<void>;
type pv_status_to_string_type = (status: number) => Promise<number>
type pv_sample_rate_type = () => Promise<number>;
type pv_porcupine_frame_length_type = () => Promise<number>;
type pv_porcupine_version_type = () => Promise<number>;

/**
 * JavaScript/WebAssembly Binding for the Picovoice Porcupine wake word engine.
 *
 * The instances have JavaScript bindings that wrap the calls to the C library and
 * do some rudimentary type checking and parameter validation.
 */

type PorcupineWasmOutput = {
  aligned_alloc: aligned_alloc_type;
  frameLength: number;
  inputBufferAddress: number;
  keywordIndexAddress: number;
  memory: WebAssembly.Memory;
  objectAddress: number;
  pvFree: pv_free_type;
  pvPorcupineDelete: pv_porcupine_delete_type;
  pvPorcupineProcess: pv_porcupine_process_type;
  pvStatusToString: pv_status_to_string_type;
  sampleRate: number;
  version: string;
};

const PV_STATUS_SUCCESS = 10000;

export class Porcupine {
  private readonly _pvPorcupineDelete: pv_porcupine_delete_type;
  private readonly _pvPorcupineProcess: pv_porcupine_process_type;
  private readonly _pvStatusToString: pv_status_to_string_type;

  private _wasmMemory: WebAssembly.Memory | undefined;
  private readonly _pvFree: pv_free_type;
  private readonly _memoryBuffer: Int16Array;
  private readonly _memoryBufferUint8: Uint8Array;
  private readonly _memoryBufferView: DataView;
  private readonly _processMutex: Mutex;

  private readonly _objectAddress: number;
  private readonly _inputBufferAddress: number;
  private readonly _alignedAlloc: aligned_alloc_type;
  private readonly _keywordIndexAddress: number;
  private readonly _keywordLabels: Map<number, string>;

  private static _frameLength: number;
  private static _sampleRate: number;
  private static _version: string;
  private static _wasm: string;
  private static _wasmSimd: string;

  private static _porcupineMutex = new Mutex();

  private readonly _keywordDetectionCallback: (porcupineDetection: PorcupineDetection) => void;
  private readonly _processErrorCallback?: (error: string) => void;

  private constructor(
    handleWasm: PorcupineWasmOutput,
    keywordLabels: ArrayLike<string>,
    keywordDetectionCallback: (porcupineDetection: PorcupineDetection) => void,
    processErrorCallback?: (error: string) => void,
  ) {
    Porcupine._frameLength = handleWasm.frameLength;
    Porcupine._sampleRate = handleWasm.sampleRate;
    Porcupine._version = handleWasm.version;

    this._pvPorcupineDelete = handleWasm.pvPorcupineDelete;
    this._pvPorcupineProcess = handleWasm.pvPorcupineProcess;
    this._pvStatusToString = handleWasm.pvStatusToString;

    this._wasmMemory = handleWasm.memory;
    this._pvFree = handleWasm.pvFree;
    this._objectAddress = handleWasm.objectAddress;
    this._inputBufferAddress = handleWasm.inputBufferAddress;
    this._alignedAlloc = handleWasm.aligned_alloc;
    this._keywordIndexAddress = handleWasm.keywordIndexAddress;

    this._memoryBuffer = new Int16Array(handleWasm.memory.buffer);
    this._memoryBufferUint8 = new Uint8Array(handleWasm.memory.buffer);
    this._memoryBufferView = new DataView(handleWasm.memory.buffer);

    this._keywordLabels = new Map();
    for (let i = 0; i < keywordLabels.length; i++) {
      this._keywordLabels.set(i, keywordLabels[i]);
    }

    this._processMutex = new Mutex();

    this._keywordDetectionCallback = keywordDetectionCallback;
    this._processErrorCallback = processErrorCallback;
  }

  /**
   * Get Porcupine engine version.
   */
  get version(): string {
    return Porcupine._version;
  }

  /**
   * Get frame length.
   */
  get frameLength(): number {
    return Porcupine._frameLength;
  }

  /**
   * Get sample rate.
   */
  get sampleRate(): number {
    return Porcupine._sampleRate;
  }

  /**
   * Get keyword labels.
   */
  get keywordLabels(): Map<number, string> {
    return this._keywordLabels;
  }

  /**
   * Creates an instance of the Porcupine wake word engine using a base64'd string
   * of the model file. The model size is large, hence it will try to use the
   * existing one if it exists, otherwise saves the model in storage.
   *
   * @param accessKey AccessKey generated by Picovoice Console.
   * @param keywords - Built-in or Base64
   * representations of keywords and their sensitivities.
   * Can be provided as an array or a single keyword.
   * @param keywordDetectionCallback User-defined callback to run after a keyword is detected.
   * @param modelBase64 The model in base64 string to initialize Porcupine.
   * @param options Optional configuration arguments.
   * @param options.processErrorCallback User-defined callback invoked if any error happens
   * while processing the audio stream. Its only input argument is the error message.
   * @param options.customWritePath Custom path to save the model in storage.
   * Set to a different name to use multiple models across `porcupine` instances.
   * @param options.forceWrite Flag to overwrite the model in storage even if it exists.
   * @param options.version Porcupine model version. Set to a higher number to update the model file.
   * @returns An instance of the Porcupine engine.
   */
  public static async fromBase64(
    accessKey: string,
    keywords: Array<PorcupineKeyword | BuiltInKeyword> | PorcupineKeyword | BuiltInKeyword,
    keywordDetectionCallback: (porcupineDetection: PorcupineDetection) => void,
    modelBase64: string,
    options: PorcupineOptions = {},
  ): Promise<Porcupine> {
    const { customWritePath = 'porcupine_model', forceWrite = false, version = 1 } = options;
    await fromBase64(customWritePath, modelBase64, forceWrite, version);
    const [keywordLabels, sensitivities] = await keywordsProcess(keywords);
    return this.create(
      accessKey,
      keywordLabels,
      keywordDetectionCallback,
      sensitivities,
      customWritePath);
  }

  /**
   * Creates an instance of the Porcupine wake word engine using '.pv' file in
   * public directory. The model size is large, hence it will try to use the existing one if it exists,
   * otherwise saves the model in storage.
   *
   * @param accessKey AccessKey generated by Picovoice Console.
   * @param keywords - Built-in or Base64
   * representations of keywords and their sensitivities.
   * Can be provided as an array or a single keyword.
   * @param keywordDetectionCallback User-defined callback to run after a keyword is detected.
   * @param publicPath The model path relative to the public directory.
   * @param options Optional configuration arguments.
   * @param options.processErrorCallback User-defined callback invoked if any error happens
   * while processing the audio stream. Its only input argument is the error message.
   * @param options.customWritePath Custom path to save the model in storage.
   * Set to a different name to use multiple models across `porcupine` instances.
   * @param options.forceWrite Flag to overwrite the model in storage even if it exists.
   * @param options.version Porcupine model version. Set to a higher number to update the model file.
   *
   * @returns An instance of the Porcupine engine.
   */
  public static async fromPublicDirectory(
    accessKey: string,
    keywords: Array<PorcupineKeyword | BuiltInKeyword> | PorcupineKeyword | BuiltInKeyword,
    keywordDetectionCallback: (porcupineDetection: PorcupineDetection) => void,
    publicPath: string,
    options: PorcupineOptions = {},
  ): Promise<Porcupine> {
    const { customWritePath = 'porcupine_model', forceWrite = false, version = 1 } = options;
    await fromPublicDirectory(customWritePath, publicPath, forceWrite, version);
    const [keywordLabels, sensitivities] = await keywordsProcess(keywords);
    return this.create(
      accessKey,
      keywordLabels,
      keywordDetectionCallback,
      sensitivities,
      customWritePath);
  }

  /**
   * Set base64 wasm file.
   * @param wasm Base64'd wasm file to use to initialize wasm.
   */
  public static setWasm(wasm: string): void {
    if (this._wasm === undefined) {
      this._wasm = wasm;
    }
  }

  /**
   * Set base64 wasm file with SIMD feature.
   * @param wasmSimd Base64'd wasm file to use to initialize wasm.
   */
  public static setWasmSimd(wasmSimd: string): void {
    if (this._wasmSimd === undefined) {
      this._wasmSimd = wasmSimd;
    }
  }

  /**
   * Creates an instance of the Porcupine wake word engine.
   * Behind the scenes, it requires the WebAssembly code to load and initialize before
   * it can create an instance.
   *
   * @param accessKey AccessKey obtained from Picovoice Console (https://console.picovoice.ai/)
   * @param keywordLabels - Array of keyword labels. It's also the paths to the stored keyword models inside indexedDB.
   * @param keywordDetectionCallback User-defined callback to run after a keyword is detected.
   * @param sensitivities - Sensitivity of the keywords.
   * @param modelPath Path to the model saved in indexedDB.
   *
   * @returns An instance of the Porcupine engine.
   */
  public static async create(
    accessKey: string,
    keywordLabels: Array<string>,
    keywordDetectionCallback: (porcupineDetection: PorcupineDetection) => void,
    sensitivities: Float32Array,
    modelPath: string,
    options: PorcupineOptions = {},
  ): Promise<Porcupine> {

    if (!isAccessKeyValid(accessKey)) {
      throw new Error('Invalid AccessKey');
    }

    const { processErrorCallback } = options;

    return new Promise<Porcupine>((resolve, reject) => {
      Porcupine._porcupineMutex
        .runExclusive(async () => {
          const isSimd = await simd();
          const wasmOutput = await Porcupine.initWasm(
            accessKey.trim(),
            (isSimd) ? this._wasmSimd : this._wasm,
            modelPath,
            keywordLabels,
            sensitivities);
          return new Porcupine(
            wasmOutput,
            keywordLabels,
            keywordDetectionCallback,
            processErrorCallback);
        })
        .then((result: Porcupine) => {
          resolve(result);
        })
        .catch((error: any) => {
          reject(error);
        });
    });
  }

  /**
   * Processes a frame of audio. The required sample rate can be retrieved from '.sampleRate' and the length
   * of frame (number of audio samples per frame) can be retrieved from '.frameLength' The audio needs to be
   * 16-bit linearly-encoded. Furthermore, the engine operates on single-channel audio.
   *
   * @param pcm A frame of audio with properties described above.
   */
  public async process(pcm: Int16Array): Promise<void> {
    if (!(pcm instanceof Int16Array)) {
      const error = new Error('The argument \'pcm\' must be provided as an Int16Array');
      if (this._processErrorCallback) {
        this._processErrorCallback(error.toString());
      } else {
        // eslint-disable-next-line no-console
        console.error(error);
      }
    }

    this._processMutex
      .runExclusive(async () => {
        if (this._wasmMemory === undefined) {
          throw new Error('Attempted to call Porcupine process after release.');
        }

        this._memoryBuffer.set(
          pcm,
          this._inputBufferAddress / Int16Array.BYTES_PER_ELEMENT,
        );

        const status = await this._pvPorcupineProcess(
          this._objectAddress,
          this._inputBufferAddress,
          this._keywordIndexAddress,
        );
        if (status !== PV_STATUS_SUCCESS) {
          const memoryBuffer = new Uint8Array(this._wasmMemory.buffer);
          throw new Error(
            `process failed with status ${arrayBufferToStringAtIndex(
              memoryBuffer,
              await this._pvStatusToString(status),
            )}`,
          );
        }

        const keywordIndex =  this._memoryBufferView.getInt32(
          this._keywordIndexAddress,
          true,
        );

        if (keywordIndex !== -1) {
          this._keywordDetectionCallback({
            label: this._keywordLabels.get(keywordIndex) ?? '',
            index: keywordIndex,
          });
        }

      })
      .catch((error: any) => {
        if (this._processErrorCallback) {
          this._processErrorCallback(error.toString());
        } else {
          // eslint-disable-next-line no-console
          console.error(error);
        }
  });
}

  /**
   * Releases resources acquired by WebAssembly module.
   */
  public async release(): Promise<void> {
    await this._pvPorcupineDelete(this._objectAddress);
    await this._pvFree(this._inputBufferAddress);
    await this._pvFree(this._keywordIndexAddress);
    delete this._wasmMemory;
    this._wasmMemory = undefined;
  }

  async onmessage(e: MessageEvent): Promise<void> {
    switch (e.data.command) {
      case 'process':
        await this.process(e.data.inputFrame);
        break;
      default:
        // eslint-disable-next-line no-console
        console.warn(`Unrecognized command: ${e.data.command}`);
    }
  }

  private static async initWasm(
    accessKey: string,
    wasmBase64: string,
    modelPath: string,
    keywordPaths: Array<string>,
    sensitivities: Float32Array): Promise<any> {
    // A WebAssembly page has a constant size of 64KiB. -> 1MiB ~= 16 pages
    // minimum memory requirements for init: 17 pages
    const memory = new WebAssembly.Memory({ initial: 128 });

    const memoryBufferUint8 = new Uint8Array(memory.buffer);
    const memoryBufferInt32 = new Int32Array(memory.buffer);
    const memoryBufferFloat32 = new Float32Array(memory.buffer);

    const exports = await buildWasm(memory, wasmBase64);

    const aligned_alloc = exports.aligned_alloc as aligned_alloc_type;
    const pv_free = exports.pv_free as pv_free_type;
    const pv_porcupine_version = exports.pv_porcupine_version as pv_porcupine_version_type;
    const pv_porcupine_frame_length = exports.pv_porcupine_frame_length as pv_porcupine_frame_length_type;
    const pv_porcupine_process = exports.pv_porcupine_process as pv_porcupine_process_type;
    const pv_porcupine_delete = exports.pv_porcupine_delete as pv_porcupine_delete_type;
    const pv_porcupine_init = exports.pv_porcupine_init as pv_porcupine_init_type;
    const pv_status_to_string = exports.pv_status_to_string as pv_status_to_string_type;
    const pv_sample_rate = exports.pv_sample_rate as pv_sample_rate_type;

    // acquire and init memory for c_object
    const objectAddressAddress = await aligned_alloc(
      Int32Array.BYTES_PER_ELEMENT,
      Int32Array.BYTES_PER_ELEMENT,
    );
    if (objectAddressAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }

    // acquire and init memory for c_access_key
    const accessKeyAddress = await aligned_alloc(
      Uint8Array.BYTES_PER_ELEMENT,
      (accessKey.length + 1) * Uint8Array.BYTES_PER_ELEMENT,
    );
    if (accessKeyAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }
    for (let i = 0; i < accessKey.length; i++) {
      memoryBufferUint8[accessKeyAddress + i] = accessKey.charCodeAt(i);
    }
    memoryBufferUint8[accessKeyAddress + accessKey.length] = 0;

    // acquire and init memory for c_model_path
    const modelPathAddress = await aligned_alloc(
      Uint8Array.BYTES_PER_ELEMENT,
      (modelPath.length + 1) * Uint8Array.BYTES_PER_ELEMENT,
    );
    if (modelPathAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }
    for (let i = 0; i < modelPath.length; i++) {
      memoryBufferUint8[modelPathAddress + i] = modelPath.charCodeAt(i);
    }
    memoryBufferUint8[modelPathAddress + modelPath.length] = 0;

    // acquire and init memory for c_keyword_paths
    const keywordPathsAddressAddress = await aligned_alloc(
      Int32Array.BYTES_PER_ELEMENT,
      keywordPaths.length * Int32Array.BYTES_PER_ELEMENT,
    );
    if (keywordPathsAddressAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }

    const keywordPathsAddressList = [];
    for (const keywordPath of keywordPaths) {
      const keywordPathAddress = await aligned_alloc(
        Uint8Array.BYTES_PER_ELEMENT,
        (keywordPath.length + 1) * Uint8Array.BYTES_PER_ELEMENT,
      );
      if (keywordPathAddress === 0) {
        throw new Error('malloc failed: Cannot allocate memory');
      }
      for (let i = 0; i < keywordPath.length; i++) {
        memoryBufferUint8[keywordPathAddress + i] = keywordPath.charCodeAt(i);
      }
      memoryBufferUint8[keywordPathAddress + keywordPath.length] = 0;
      keywordPathsAddressList.push(keywordPathAddress);
    }
    memoryBufferInt32.set(
      new Int32Array(keywordPathsAddressList),
      keywordPathsAddressAddress / Int32Array.BYTES_PER_ELEMENT,
    );

    const sensitivityAddress = await aligned_alloc(
      Float32Array.BYTES_PER_ELEMENT,
      keywordPaths.length * Float32Array.BYTES_PER_ELEMENT,
    );
    if (sensitivityAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }
    memoryBufferFloat32.set(
      sensitivities,
      sensitivityAddress / Float32Array.BYTES_PER_ELEMENT,
    );

    const keywordIndexAddress = await aligned_alloc(
      Int32Array.BYTES_PER_ELEMENT,
      Int32Array.BYTES_PER_ELEMENT,
    );
    if (keywordIndexAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }

    const status = await pv_porcupine_init(
      accessKeyAddress,
      modelPathAddress,
      keywordPaths.length,
      keywordPathsAddressAddress,
      sensitivityAddress,
      objectAddressAddress);

    await pv_free(accessKeyAddress);
    await pv_free(modelPathAddress);
    await pv_free(keywordPathsAddressAddress);
    await pv_free(sensitivityAddress);

    if (status !== PV_STATUS_SUCCESS) {
      throw new Error(
        `'pv_porcupine_init' failed with status ${arrayBufferToStringAtIndex(
          memoryBufferUint8,
          await pv_status_to_string(status),
        )}`,
      );
    }
    const memoryBufferView = new DataView(memory.buffer);
    const objectAddress = memoryBufferView.getInt32(objectAddressAddress, true);
    await pv_free(objectAddressAddress);

    const sampleRate = await pv_sample_rate();
    const frameLength = await pv_porcupine_frame_length();
    const versionAddress = await pv_porcupine_version();
    const version = arrayBufferToStringAtIndex(
      memoryBufferUint8,
      versionAddress,
    );

    const inputBufferAddress = await aligned_alloc(
      Int16Array.BYTES_PER_ELEMENT,
      frameLength * Int16Array.BYTES_PER_ELEMENT,
    );
    if (inputBufferAddress === 0) {
      throw new Error('malloc failed: Cannot allocate memory');
    }

    return {
      aligned_alloc,
      frameLength: frameLength,
      inputBufferAddress: inputBufferAddress,
      keywordIndexAddress: keywordIndexAddress,
      memory: memory,
      objectAddress: objectAddress,
      pvFree: pv_free,
      pvPorcupineDelete: pv_porcupine_delete,
      pvPorcupineProcess: pv_porcupine_process,
      pvStatusToString: pv_status_to_string,
      sampleRate: sampleRate,
      version: version,
    };
  }
}