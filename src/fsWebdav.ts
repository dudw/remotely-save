import { getReasonPhrase } from "http-status-codes/build/cjs/utils-functions";
import { Buffer } from "buffer";
import cloneDeep from "lodash/cloneDeep";
import { Queue } from "@fyears/tsqueue";
import chunk from "lodash/chunk";
import flatten from "lodash/flatten";
import { Platform, requestUrl } from "obsidian";
import { FakeFs } from "./fsAll";
import { bufferToArrayBuffer } from "./misc";
import { Entity, WebdavConfig } from "./baseTypes";
import { VALID_REQURL } from "./baseTypesObs";
import type {
  FileStat,
  WebDAVClient,
  RequestOptionsWithState,
  // Response,
  // ResponseDataDetailed,
} from "webdav";

/**
 * https://stackoverflow.com/questions/32850898/how-to-check-if-a-string-has-any-non-iso-8859-1-characters-with-javascript
 * @param str
 * @returns true if all are iso 8859 1 chars
 */
function onlyAscii(str: string) {
  return !/[^\u0000-\u00ff]/g.test(str);
}

/**
 * https://stackoverflow.com/questions/12539574/
 * @param obj
 * @returns
 */
function objKeyToLower(obj: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  );
}

// @ts-ignore
import { getPatcher } from "webdav/dist/web/index.js";
if (VALID_REQURL) {
  getPatcher().patch(
    "request",
    async (options: RequestOptionsWithState): Promise<Response> => {
      const transformedHeaders = objKeyToLower({ ...options.headers });
      delete transformedHeaders["host"];
      delete transformedHeaders["content-length"];

      const reqContentType =
        transformedHeaders["accept"] ?? transformedHeaders["content-type"];

      const retractedHeaders = { ...transformedHeaders };
      if (retractedHeaders.hasOwnProperty("authorization")) {
        retractedHeaders["authorization"] = "<retracted>";
      }

      console.debug(`before request:`);
      console.debug(`url: ${options.url}`);
      console.debug(`method: ${options.method}`);
      console.debug(`headers: ${JSON.stringify(retractedHeaders, null, 2)}`);
      console.debug(`reqContentType: ${reqContentType}`);

      let r = await requestUrl({
        url: options.url,
        method: options.method,
        body: options.data as string | ArrayBuffer,
        headers: transformedHeaders,
        contentType: reqContentType,
        throw: false,
      });

      if (
        r.status === 401 &&
        Platform.isIosApp &&
        !options.url.endsWith("/") &&
        !options.url.endsWith(".md") &&
        options.method.toUpperCase() === "PROPFIND"
      ) {
        // don't ask me why,
        // some webdav servers have some mysterious behaviours,
        // if a folder doesn't exist without slash, the servers return 401 instead of 404
        // here is a dirty hack that works
        console.debug(`so we have 401, try appending request url with slash`);
        r = await requestUrl({
          url: `${options.url}/`,
          method: options.method,
          body: options.data as string | ArrayBuffer,
          headers: transformedHeaders,
          contentType: reqContentType,
          throw: false,
        });
      }

      console.debug(`after request:`);
      const rspHeaders = objKeyToLower({ ...r.headers });
      console.debug(`rspHeaders: ${JSON.stringify(rspHeaders, null, 2)}`);
      for (let key in rspHeaders) {
        if (rspHeaders.hasOwnProperty(key)) {
          // avoid the error:
          // Failed to read the 'headers' property from 'ResponseInit': String contains non ISO-8859-1 code point.
          // const possibleNonAscii = [
          //   "Content-Disposition",
          //   "X-Accel-Redirect",
          //   "X-Outfilename",
          //   "X-Sendfile"
          // ];
          // for (const p of possibleNonAscii) {
          //   if (key === p || key === p.toLowerCase()) {
          //     rspHeaders[key] = encodeURIComponent(rspHeaders[key]);
          //   }
          // }
          if (!onlyAscii(rspHeaders[key])) {
            console.debug(`rspHeaders[key] needs encode: ${key}`);
            rspHeaders[key] = encodeURIComponent(rspHeaders[key]);
          }
        }
      }

      let r2: Response | undefined = undefined;
      const statusText = getReasonPhrase(r.status);
      console.debug(`statusText: ${statusText}`);
      if ([101, 103, 204, 205, 304].includes(r.status)) {
        // A null body status is a status that is 101, 103, 204, 205, or 304.
        // https://fetch.spec.whatwg.org/#statuses
        // fix this: Failed to construct 'Response': Response with null body status cannot have body
        r2 = new Response(null, {
          status: r.status,
          statusText: statusText,
          headers: rspHeaders,
        });
      } else {
        r2 = new Response(r.arrayBuffer, {
          status: r.status,
          statusText: statusText,
          headers: rspHeaders,
        });
      }

      return r2;
    }
  );
}

// @ts-ignore
import { AuthType, BufferLike, createClient } from "webdav/dist/web/index.js";

export const DEFAULT_WEBDAV_CONFIG = {
  address: "",
  username: "",
  password: "",
  authType: "basic",
  manualRecursive: true,
  depth: "manual_1",
  remoteBaseDir: "",
} as WebdavConfig;

const getWebdavPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    // special
    key = `/${remoteBaseDir}/`;
  } else if (fileOrFolderPath.startsWith("/")) {
    console.warn(
      `why the path ${fileOrFolderPath} starts with '/'? but we just go on.`
    );
    key = `/${remoteBaseDir}${fileOrFolderPath}`;
  } else {
    key = `/${remoteBaseDir}/${fileOrFolderPath}`;
  }
  return key;
};

const getNormPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  if (
    !(
      fileOrFolderPath === `/${remoteBaseDir}` ||
      fileOrFolderPath.startsWith(`/${remoteBaseDir}/`)
    )
  ) {
    throw Error(
      `"${fileOrFolderPath}" doesn't starts with "/${remoteBaseDir}/"`
    );
  }

  return fileOrFolderPath.slice(`/${remoteBaseDir}/`.length);
};

const fromWebdavItemToEntity = (x: FileStat, remoteBaseDir: string): Entity => {
  let key = getNormPath(x.filename, remoteBaseDir);
  if (x.type === "directory" && !key.endsWith("/")) {
    key = `${key}/`;
  }
  const mtimeSvr = Date.parse(x.lastmod).valueOf();
  return {
    key: key,
    keyRaw: key,
    mtimeSvr: mtimeSvr,
    mtimeCli: mtimeSvr, // TODO: no universal way to set mtime in webdav
    size: x.size,
    sizeRaw: x.size,
  };
};

export class FakeFsWebdav extends FakeFs {
  kind: "webdav";

  webdavConfig: WebdavConfig;
  remoteBaseDir: string;
  client!: WebDAVClient;
  vaultFolderExists: boolean;
  saveUpdatedConfigFunc: () => Promise<any>;

  constructor(
    webdavConfig: WebdavConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<any>
  ) {
    super();
    this.kind = "webdav";
    this.webdavConfig = cloneDeep(webdavConfig);
    this.webdavConfig.address = encodeURI(this.webdavConfig.address);
    this.remoteBaseDir = this.webdavConfig.remoteBaseDir || vaultName || "";
    this.vaultFolderExists = false;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
  }

  async _init() {
    // init client if not inited
    if (this.client !== undefined) {
      return;
    }

    if (Platform.isIosApp && !this.webdavConfig.address.startsWith("https")) {
      throw Error(
        `Your webdav address could only be https, not http, because of the iOS restriction.`
      );
    }

    const headers = {
      "Cache-Control": "no-cache",
    };
    if (
      this.webdavConfig.username !== "" &&
      this.webdavConfig.password !== ""
    ) {
      this.client = createClient(this.webdavConfig.address, {
        username: this.webdavConfig.username,
        password: this.webdavConfig.password,
        headers: headers,
        authType:
          this.webdavConfig.authType === "digest"
            ? AuthType.Digest
            : AuthType.Password,
      });
    } else {
      console.info("no password");
      this.client = createClient(this.webdavConfig.address, {
        headers: headers,
      });
    }

    // check vault folder
    if (this.vaultFolderExists) {
      // pass
    } else {
      const res = await this.client.exists(`/${this.remoteBaseDir}/`);
      if (res) {
        // console.info("remote vault folder exits!");
        this.vaultFolderExists = true;
      } else {
        console.info("remote vault folder not exists, creating");
        await this.client.createDirectory(`/${this.remoteBaseDir}/`);
        console.info("remote vault folder created!");
        this.vaultFolderExists = true;
      }
    }

    // adjust depth parameter
    if (
      this.webdavConfig.depth === "auto" ||
      this.webdavConfig.depth === "auto_1" ||
      this.webdavConfig.depth === "auto_infinity" ||
      this.webdavConfig.depth === "auto_unknown"
    ) {
      this.webdavConfig.depth = "manual_1";
      this.webdavConfig.manualRecursive = true;
      if (this.saveUpdatedConfigFunc !== undefined) {
        await this.saveUpdatedConfigFunc();
        console.info(
          `webdav depth="auto_???" is changed to ${this.webdavConfig.depth}`
        );
      }
    }
  }

  async walk(): Promise<Entity[]> {
    await this._init();

    let contents = [] as FileStat[];
    if (
      this.webdavConfig.depth === "auto" ||
      this.webdavConfig.depth === "auto_unknown" ||
      this.webdavConfig.depth === "auto_1" ||
      this.webdavConfig.depth === "auto_infinity" /* don't trust auto now */ ||
      this.webdavConfig.depth === "manual_1"
    ) {
      // the remote doesn't support infinity propfind,
      // we need to do a bfs here
      const q = new Queue([`/${this.remoteBaseDir}`]);
      const CHUNK_SIZE = 10;
      while (q.length > 0) {
        const itemsToFetch: string[] = [];
        while (q.length > 0) {
          itemsToFetch.push(q.pop()!);
        }
        const itemsToFetchChunks = chunk(itemsToFetch, CHUNK_SIZE);
        // console.debug(itemsToFetchChunks);
        const subContents = [] as FileStat[];
        for (const singleChunk of itemsToFetchChunks) {
          const r = singleChunk.map((x) => {
            return this.client.getDirectoryContents(x, {
              deep: false,
              details: false /* no need for verbose details here */,
              // TODO: to support .obsidian,
              // we need to load all files including dot,
              // anyway to reduce the resources?
              // glob: "/**" /* avoid dot files by using glob */,
            }) as Promise<FileStat[]>;
          });
          const r2 = flatten(await Promise.all(r));
          subContents.push(...r2);
        }
        for (let i = 0; i < subContents.length; ++i) {
          const f = subContents[i];
          contents.push(f);
          if (f.type === "directory") {
            q.push(f.filename);
          }
        }
      }
    } else {
      // the remote supports infinity propfind
      contents = (await this.client.getDirectoryContents(
        `/${this.remoteBaseDir}`,
        {
          deep: true,
          details: false /* no need for verbose details here */,
          // TODO: to support .obsidian,
          // we need to load all files including dot,
          // anyway to reduce the resources?
          // glob: "/**" /* avoid dot files by using glob */,
        }
      )) as FileStat[];
    }
    return contents.map((x) => fromWebdavItemToEntity(x, this.remoteBaseDir));
  }

  async stat(key: string): Promise<Entity> {
    await this._init();
    const fullPath = getWebdavPath(key, this.remoteBaseDir);
    return await this._statFromRoot(fullPath);
  }

  async _statFromRoot(key: string): Promise<Entity> {
    const res = (await this.client.stat(key, {
      details: false,
    })) as FileStat;
    return fromWebdavItemToEntity(res, this.remoteBaseDir);
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!key.endsWith("/")) {
      throw Error(`you should not call mkdir on ${key}`);
    }
    await this._init();
    const uploadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._mkdirFromRoot(uploadFile, mtime, ctime);
  }

  async _mkdirFromRoot(
    key: string,
    mtime?: number,
    ctime?: number
  ): Promise<Entity> {
    await this.client.createDirectory(key, {
      recursive: true,
    });
    return await this._statFromRoot(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    if (key.endsWith("/")) {
      throw Error(`you should not call writeFile on ${key}`);
    }
    await this._init();
    const uploadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._writeFileFromRoot(uploadFile, content, mtime, ctime);
  }

  async _writeFileFromRoot(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    await this.client.putFileContents(key, content, {
      overwrite: true,
      onUploadProgress: (progress: any) => {
        console.info(`Uploaded ${progress.loaded} bytes of ${progress.total}`);
      },
    });
    return await this._statFromRoot(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    if (key.endsWith("/")) {
      throw Error(`you should not call readFile on ${key}`);
    }
    await this._init();
    const downloadFile = getWebdavPath(key, this.remoteBaseDir);
    return await this._readFileFromRoot(downloadFile);
  }

  async _readFileFromRoot(key: string): Promise<ArrayBuffer> {
    const buff = (await this.client.getFileContents(key)) as BufferLike;
    if (buff instanceof ArrayBuffer) {
      return buff;
    } else if (buff instanceof Buffer) {
      return bufferToArrayBuffer(buff);
    }
    throw Error(`unexpected file content result with type ${typeof buff}`);
  }

  async rm(key: string): Promise<void> {
    if (key === "/") {
      return;
    }
    await this._init();
    try {
      const remoteFileName = getWebdavPath(key, this.remoteBaseDir);
      await this.client.deleteFile(remoteFileName);
      // console.info(`delete ${remoteFileName} succeeded`);
    } catch (err) {
      console.error("some error while deleting");
      console.error(err);
    }
  }

  async checkConnect(callbackFunc?: any): Promise<boolean> {
    if (
      !(
        this.webdavConfig.address.startsWith("http://") ||
        this.webdavConfig.address.startsWith("https://")
      )
    ) {
      const err =
        "Error: the url should start with http(s):// but it does not!";
      console.error(err);
      if (callbackFunc !== undefined) {
        callbackFunc(err);
      }
      return false;
    }

    try {
      await this._init();
      const results = await this._statFromRoot(`/${this.remoteBaseDir}/`);
      if (results === undefined) {
        const err = "results is undefined";
        console.error(err);
        callbackFunc?.(err);
        return false;
      }
      return true;
    } catch (err) {
      console.error(err);
      callbackFunc?.(err);
      return false;
    }
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async revokeAuth() {
    throw new Error("Method not implemented.");
  }
}
