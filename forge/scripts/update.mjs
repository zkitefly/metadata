#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'index.json');

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const MAVEN_XML_URL =
    'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const MAVEN_BASE_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;
const HEAD_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const CONCURRENCY = 20;

// ===========================================================================
// 日志工具
// ===========================================================================

const log = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    debug: (msg) => {
        if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`);
    },
};

// ===========================================================================
// 错误分类
// ===========================================================================

class NetworkError extends Error {
    constructor(message, { status, url } = {}) {
        super(message);
        this.name = 'NetworkError';
        this.status = status;
        this.url = url;
    }
}

class ParseError extends Error {
    constructor(message, { source } = {}) {
        super(message);
        this.name = 'ParseError';
        this.source = source;
    }
}

class FileError extends Error {
    constructor(message, { path } = {}) {
        super(message);
        this.name = 'FileError';
        this.path = path;
    }
}

class ZipError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ZipError';
    }
}

// ===========================================================================
// HTTP 工具
// ===========================================================================

/**
 * 带重试的 HTTP 请求
 * @param {string} url - 请求 URL
 * @param {object} options - fetch 选项
 * @param {number} retries - 最大重试次数
 * @returns {Promise<Response>} fetch Response 对象
 */
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(
                () => controller.abort(),
                options.timeout || FETCH_TIMEOUT_MS
            );
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
            });
            clearTimeout(timeout);
            return response;
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                log.warn(
                    `请求失败 (${attempt}/${retries}): ${url} - ${error.message}，重试中...`
                );
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    throw new NetworkError(`请求失败（已重试 ${retries} 次）: ${url}`, {
        url,
        cause: lastError,
    });
}

/**
 * HTTP HEAD 请求，检查资源是否存在
 * @param {string} url - 检查的 URL
 * @returns {Promise<boolean>} 资源是否可用（非 404 即视为可用）
 */
async function checkUrlAvailable(url) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
            const response = await fetch(url, {
                method: 'HEAD',
                signal: controller.signal,
                headers: { 'User-Agent': USER_AGENT },
            });
            clearTimeout(timeout);
            return response.status !== 404;
        } catch (error) {
            if (attempt < MAX_RETRIES) {
                log.debug(`HEAD 请求失败 (${attempt}/${MAX_RETRIES}): ${url} - ${error.message}`);
                await sleep(RETRY_DELAY_MS);
            } else {
                log.warn(`HEAD 请求最终失败: ${url} - ${error.message}`);
                return false;
            }
        }
    }
    return false;
}

/**
 * 下载文件内容为 Buffer
 * @param {string} url - 下载 URL
 * @returns {Promise<Buffer>} 文件内容
 */
async function downloadBuffer(url) {
    const response = await fetchWithRetry(url, { timeout: DOWNLOAD_TIMEOUT_MS });
    if (!response.ok) {
        throw new NetworkError(`下载失败，HTTP ${response.status}: ${url}`, {
            status: response.status,
            url,
        });
    }
    return Buffer.from(await response.arrayBuffer());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// 版本处理逻辑（原 main.py）
// ===========================================================================

/**
 * 处理单个版本字符串，生成版本信息对象
 *
 * 版本字符串格式：{mcversion}-{forgeversion} 或 {mcversion}-{forgeversion}-{branch}
 * 例如：1.21-51.0.33、1.2.3-4.5.6.7-beta
 *
 * build 编号规则：
 *   - 4 段版本号（如 1.2.3.4）：取最后一段作为编号
 *   - 3 段版本号（如 51.0.33）：major*1000000 + minor*10000 + patch
 *   - 其他：编号为 0
 *
 * files 默认值规则：
 *   - 1.1, 1.2.3, 1.2.4, 1.2.5 → [["zip", "client"]]
 *   - 1.3.2 ~ 1.5.1 → [["zip", "universal"]]
 *   - 其他 → [["jar", "installer"]]
 *
 * @param {string} versionStr - 版本字符串
 * @returns {object} 版本信息对象
 */
export function processVersion(versionStr) {
    const parts = versionStr.split('-');
    const mcversion = parts[0];
    const forgeversion = parts[1];
    const branch = parts.length > 2 ? parts[2] : null;

    const forgeParts = forgeversion.split('.');
    let build;
    if (forgeParts.length === 4) {
        build = parseInt(forgeParts[3], 10);
    } else if (forgeParts.length === 3) {
        build =
            parseInt(forgeParts[0], 10) * 1000000 +
            parseInt(forgeParts[1], 10) * 10000 +
            parseInt(forgeParts[2], 10);
    } else {
        build = 0;
    }

    const universalMcversions = new Set([
        '1.3.2', '1.4.0', '1.4.1', '1.4.2', '1.4.3',
        '1.4.4', '1.4.5', '1.4.6', '1.4.7', '1.5', '1.5.0', '1.5.1',
    ]);
    const clientMcversions = new Set(['1.1', '1.2.3', '1.2.4', '1.2.5']);

    let files;
    if (clientMcversions.has(mcversion)) {
        files = [['zip', 'client']];
    } else if (universalMcversions.has(mcversion)) {
        files = [['zip', 'universal']];
    } else {
        files = [['jar', 'installer']];
    }

    return {
        branch,
        build,
        mcversion,
        modified: 0,
        version: forgeversion,
        files,
    };
}

/**
 * 从 XML 文本中提取版本列表
 *
 * maven-metadata.xml 结构：
 *   <metadata><versioning><versions><version>...</version>...</versions></versioning></metadata>
 *
 * 使用正则提取所有 <version> 标签内容，对应原 xml_to_json.py 中 parker 转换后
 * 访问 data["versioning"]["versions"]["version"] 的结果。
 *
 * @param {string} xmlText - XML 文本
 * @returns {string[]} 版本字符串数组
 */
export function parseVersionsFromXml(xmlText) {
    const matches = [...xmlText.matchAll(/<version>([^<]+)<\/version>/g)];
    return matches.map((m) => m[1]);
}

/**
 * 构建完整的 index.json 数据结构
 * @param {string[]} versions - 版本字符串数组
 * @param {object|null} existingData - 现有 index.json 数据（用于保留已处理的 modified 和 files）
 * @returns {object} index.json 数据结构
 */
export function buildIndexData(versions, existingData) {
    const processed = versions.map(processVersion);

    // 构建已有数据查找表：build -> { modified, files }
    const existingMap = new Map();
    if (existingData && existingData.number) {
        for (const [key, entry] of Object.entries(existingData.number)) {
            existingMap.set(entry.build, entry);
        }
    }

    const numberData = {};
    const mcversionData = {};

    for (const ver of processed) {
        // 保留已处理的 modified 和 files（缓存机制：直接读取 index.json）
        // modified > 0 表示该构建已完成文件检查和时间戳提取，直接跳过
        const existing = existingMap.get(ver.build);
        if (existing && existing.modified > 0) {
            ver.modified = existing.modified;
            // 保留已验证的 files（已处理过的构建）
            if (existing.files) {
                ver.files = existing.files;
            }
        }

        numberData[String(ver.build)] = ver;

        if (!mcversionData[ver.mcversion]) {
            mcversionData[ver.mcversion] = [];
        }
        mcversionData[ver.mcversion].push(ver.build);
    }

    return {
        artifact: 'forge',
        webpath: 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/',
        mcversion: mcversionData,
        number: numberData,
    };
}

// ===========================================================================
// 文件可用性检查 + 时间戳提取（原 install.py + gettime.py，合并为单步）
// ===========================================================================

/**
 * 构建下载 URL
 * @param {object} buildInfo - 构建信息
 * @param {string} extension - 文件扩展名
 * @param {string} classifier - 文件分类符
 * @returns {string} 完整下载 URL
 */
function buildDownloadUrl(buildInfo, extension, classifier) {
    const { mcversion, version, branch } = buildInfo;
    let basePath = `${MAVEN_BASE_URL}/${mcversion}-${version}`;
    if (branch) basePath += `-${branch}`;
    basePath += `/forge-${mcversion}-${version}`;
    if (branch) basePath += `-${branch}`;
    return `${basePath}-${classifier}.${extension}`;
}

/**
 * 检查单个构建的文件可用性并提取时间戳
 *
 * 优化逻辑：如果 modified > 0，说明已处理过，直接跳过。
 * 否则执行：
 *   1. HEAD 请求检查文件是否存在
 *   2. 下载文件，提取时间戳
 *   3. 更新 files 和 modified 字段
 *
 * @param {object} buildInfo - 构建信息对象
 * @returns {Promise<object|null>} 更新后的构建信息，或 null（跳过/失败）
 */
async function processBuild(buildInfo) {
    const { build, version, mcversion } = buildInfo;

    // 缓存检查：modified > 0 表示已处理过，跳过
    if (buildInfo.modified > 0) {
        log.debug(`Build ${build} (${version}) 已处理，跳过`);
        return null;
    }

    // --- 步骤 1：文件可用性检查（原 install.py 逻辑）---
    const availableFiles = [];
    for (const [extension, classifier] of buildInfo.files) {
        const url = buildDownloadUrl(buildInfo, extension, classifier);
        const available = await checkUrlAvailable(url);
        log.info(
            `Build ${build}, 资源: ${classifier}.${extension}, 可用: ${available}`
        );
        if (available) {
            availableFiles.push([extension, classifier]);
        }
    }
    buildInfo.files = availableFiles;

    // --- 步骤 2：时间戳提取（原 gettime.py 逻辑）---
    const timestamp = await extractTimestamp(buildInfo);
    if (timestamp !== null) {
        buildInfo.modified = timestamp;
        log.info(`Build ${build} (${version}) 时间戳: ${timestamp}`);
    } else {
        log.warn(`Build ${build} (${version}) 未找到时间戳`);
    }

    return buildInfo;
}

/**
 * 从构建文件中提取时间戳
 *
 * 优先级：
 *   1. version.json 中的 time 字段
 *   2. install_profile.json 中 versionInfo.time 字段
 *   3. fmlversion.properties 的 ZIP 条目时间戳
 *   4. mod_MinecraftForge.class 的 ZIP 条目时间戳
 *   5. forge/ForgeHooks.class 的 ZIP 条目时间戳
 *
 * @param {object} buildInfo - 构建信息
 * @returns {Promise<number|null>} Unix 时间戳，或 null
 */
async function extractTimestamp(buildInfo) {
    const { build, version, branch, mcversion, files } = buildInfo;

    // 判断文件类型
    let fileType = null;
    if (files.some(([ext, cls]) => ext === 'jar' && cls === 'installer')) {
        fileType = 'installer';
    } else if (files.some(([ext, cls]) => ext === 'zip' && cls === 'universal')) {
        fileType = 'universal';
    } else if (files.some(([ext, cls]) => ext === 'zip' && cls === 'client')) {
        fileType = 'client';
    } else {
        log.debug(`Build ${build} 无支持的文件类型，跳过时间戳提取`);
        return null;
    }

    // 构建下载 URL
    let ext, suffix;
    if (fileType === 'installer') {
        ext = 'jar';
        suffix = '-installer';
    } else if (fileType === 'universal') {
        ext = 'zip';
        suffix = '-universal';
    } else {
        ext = 'zip';
        suffix = '-client';
    }

    const url = buildDownloadUrl(buildInfo, ext, fileType);

    // 下载文件
    log.info(`下载 Build ${build}: ${url}`);
    let buffer;
    try {
        buffer = await downloadBuffer(url);
    } catch (error) {
        log.warn(`Build ${build} 下载失败: ${error.message}`);
        return null;
    }

    // 解析 ZIP 文件
    let zip;
    try {
        zip = new ZipReader(buffer);
    } catch (error) {
        if (error instanceof ZipError) {
            log.warn(`Build ${build} ZIP 解析失败: ${error.message}`);
        } else {
            log.warn(`Build ${build} 文件解析失败: ${error.message}`);
        }
        return null;
    }

    // 优先级 1：version.json
    let timestamp = tryExtractFromJson(zip, 'version.json', (data) => data.time);
    if (timestamp) return timestamp;

    // 优先级 2：install_profile.json → versionInfo.time
    timestamp = tryExtractFromJson(zip, 'install_profile.json', (data) => {
        return data.versionInfo?.time;
    });
    if (timestamp) return timestamp;

    // 优先级 3：fmlversion.properties（ZIP 条目时间戳）
    timestamp = tryGetEntryTimestamp(zip, 'fmlversion.properties');
    if (timestamp) return timestamp;

    // 优先级 4：mod_MinecraftForge.class（ZIP 条目时间戳）
    const forgeClassEntry = zip.entries.find((e) =>
        e.name.endsWith('mod_MinecraftForge.class')
    );
    if (forgeClassEntry) {
        timestamp = dosToUnixTimestamp(forgeClassEntry.modDate, forgeClassEntry.modTime);
        if (timestamp) return timestamp;
    }

    // 优先级 5：forge/ForgeHooks.class（ZIP 条目时间戳）
    timestamp = tryGetEntryTimestamp(zip, 'forge/ForgeHooks.class');
    if (timestamp) return timestamp;

    return null;
}

/**
 * 尝试从 ZIP 中的 JSON 文件提取时间戳
 * @param {ZipReader} zip - ZIP 读取器
 * @param {string} entryName - 条目名称
 * @param {function} extractFn - 从解析后的 JSON 中提取时间字符串的函数
 * @returns {number|null} Unix 时间戳
 */
function tryExtractFromJson(zip, entryName, extractFn) {
    try {
        const content = zip.readEntry(entryName);
        if (content === null) return null;

        const data = JSON.parse(content.toString('utf-8'));
        const timeStr = extractFn(data);
        if (timeStr) {
            const ts = parseDateToUnix(timeStr);
            if (ts) return ts;
            log.warn(`无法解析时间字符串 '${timeStr}'（来自 ${entryName}）`);
        }
    } catch (error) {
        log.debug(`读取 ${entryName} 失败: ${error.message}`);
    }
    return null;
}

/**
 * 尝试获取 ZIP 条目的时间戳
 * @param {ZipReader} zip - ZIP 读取器
 * @param {string} entryName - 条目名称
 * @returns {number|null} Unix 时间戳
 */
function tryGetEntryTimestamp(zip, entryName) {
    const entry = zip.entries.find((e) => e.name === entryName);
    if (!entry) return null;
    return dosToUnixTimestamp(entry.modDate, entry.modTime);
}

/**
 * 将日期字符串解析为 Unix 时间戳
 * 支持 ISO 8601 格式（如 "2024-01-15T10:30:00+0000"）
 * @param {string} dateStr - 日期字符串
 * @returns {number|null} Unix 时间戳（秒），或 null
 */
function parseDateToUnix(dateStr) {
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;
        return Math.floor(date.getTime() / 1000);
    } catch {
        return null;
    }
}

/**
 * 将 MS-DOS 日期/时间转换为 Unix 时间戳
 *
 * MS-DOS 日期格式：
 *   bits 0-4: 日 (1-31)
 *   bits 5-8: 月 (1-12)
 *   bits 9-15: 年 (从 1980 起)
 *
 * MS-DOS 时间格式：
 *   bits 0-4: 秒/2
 *   bits 5-10: 分 (0-59)
 *   bits 11-15: 时 (0-23)
 *
 * @param {number} dosDate - MS-DOS 日期
 * @param {number} dosTime - MS-DOS 时间
 * @returns {number|null} Unix 时间戳（秒），或 null
 */
function dosToUnixTimestamp(dosDate, dosTime) {
    if (dosDate === 0 && dosTime === 0) return null;

    const day = dosDate & 0x1f;
    const month = (dosDate >> 5) & 0x0f;
    const year = ((dosDate >> 9) & 0x7f) + 1980;

    const second = (dosTime & 0x1f) * 2;
    const minute = (dosTime >> 5) & 0x3f;
    const hour = (dosTime >> 11) & 0x1f;

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (isNaN(date.getTime())) return null;
    return Math.floor(date.getTime() / 1000);
}

// ===========================================================================
// ZIP 文件读取器（纯 Node.js 实现，无需外部依赖）
// ===========================================================================

/**
 * ZIP 文件读取器
 *
 * 解析 ZIP 文件结构，支持读取条目列表和提取条目内容。
 * 支持存储（无压缩）和 deflate 压缩方式。
 */
class ZipReader {
    /**
     * @param {Buffer} buffer - ZIP 文件内容
     */
    constructor(buffer) {
        this.buffer = buffer;
        this.entries = [];
        this._parse();
    }

    /**
     * 解析 ZIP 中央目录
     * @throws {ZipError} ZIP 格式无效
     */
    _parse() {
        // 查找 EOCD（End of Central Directory）记录
        const eocdOffset = this._findEocd();
        if (eocdOffset === -1) {
            throw new ZipError('未找到 EOCD 记录，可能不是有效的 ZIP 文件');
        }

        // 解析 EOCD
        const cdEntryCount = this.buffer.readUInt16LE(eocdOffset + 10);
        const cdSize = this.buffer.readUInt32LE(eocdOffset + 12);
        const cdOffset = this.buffer.readUInt32LE(eocdOffset + 16);

        // 解析中央目录条目
        let offset = cdOffset;
        for (let i = 0; i < cdEntryCount; i++) {
            if (offset + 46 > this.buffer.length) {
                throw new ZipError('中央目录条目不完整');
            }

            const signature = this.buffer.readUInt32LE(offset);
            if (signature !== 0x02014b50) {
                throw new ZipError(`无效的中央目录签名: 0x${signature.toString(16)}`);
            }

            const compressionMethod = this.buffer.readUInt16LE(offset + 10);
            const modTime = this.buffer.readUInt16LE(offset + 12);
            const modDate = this.buffer.readUInt16LE(offset + 14);
            const compressedSize = this.buffer.readUInt32LE(offset + 20);
            const uncompressedSize = this.buffer.readUInt32LE(offset + 24);
            const fileNameLength = this.buffer.readUInt16LE(offset + 28);
            const extraFieldLength = this.buffer.readUInt16LE(offset + 30);
            const fileCommentLength = this.buffer.readUInt16LE(offset + 32);
            const localHeaderOffset = this.buffer.readUInt32LE(offset + 42);

            const fileName = this.buffer.toString(
                'utf-8',
                offset + 46,
                offset + 46 + fileNameLength
            );

            this.entries.push({
                name: fileName,
                compressionMethod,
                modTime,
                modDate,
                compressedSize,
                uncompressedSize,
                localHeaderOffset,
            });

            offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
        }
    }

    /**
     * 查找 EOCD 记录
     * @returns {number} EOCD 偏移量，或 -1
     */
    _findEocd() {
        const minEocdSize = 22;
        const maxSearchSize = 65557; // 64KB + EOCD size
        const searchStart = Math.max(0, this.buffer.length - maxSearchSize);

        for (let i = this.buffer.length - minEocdSize; i >= searchStart; i--) {
            if (this.buffer.readUInt32LE(i) === 0x06054b50) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 读取条目内容
     * @param {string} entryName - 条目名称
     * @returns {Buffer|null} 条目内容，或 null（条目不存在）
     * @throws {ZipError} 解压失败
     */
    readEntry(entryName) {
        const entry = this.entries.find((e) => e.name === entryName);
        if (!entry) return null;

        // 读取本地文件头
        const lho = entry.localHeaderOffset;
        if (lho + 30 > this.buffer.length) {
            throw new ZipError('本地文件头不完整');
        }

        const localFileNameLength = this.buffer.readUInt16LE(lho + 26);
        const localExtraFieldLength = this.buffer.readUInt16LE(lho + 28);
        const dataOffset = lho + 30 + localFileNameLength + localExtraFieldLength;

        const compressedData = this.buffer.subarray(
            dataOffset,
            dataOffset + entry.compressedSize
        );

        if (entry.compressionMethod === 0) {
            // 存储（无压缩）
            return compressedData;
        } else if (entry.compressionMethod === 8) {
            // deflate 压缩
            try {
                return inflateSync(compressedData);
            } catch (error) {
                throw new ZipError(`deflate 解压失败 (${entryName}): ${error.message}`);
            }
        } else {
            throw new ZipError(
                `不支持的压缩方法: ${entry.compressionMethod} (${entryName})`
            );
        }
    }
}

// ===========================================================================
// 并发处理工具
// ===========================================================================

/**
 * 并发执行异步任务
 * @param {Array} items - 待处理项
 * @param {function} fn - 处理函数
 * @param {number} concurrency - 并发数
 */
async function processConcurrently(items, fn, concurrency = CONCURRENCY) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(batch.map(fn));
        for (const result of batchResults) {
            if (result.status === 'fulfilled' && result.value) {
                results.push(result.value);
            } else if (result.status === 'rejected') {
                log.error(`处理异常: ${result.reason?.message || result.reason}`);
            }
        }
    }
    return results;
}

// ===========================================================================
// 主流程
// ===========================================================================

/**
 * 读取现有 index.json
 * @returns {object|null} 现有数据，或 null
 */
function readExistingIndex() {
    if (existsSync(INDEX_PATH)) {
        try {
            const content = readFileSync(INDEX_PATH, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            log.warn(`读取现有 index.json 失败: ${error.message}，将重新构建`);
        }
    }
    return null;
}

/**
 * 主函数
 */
async function main() {
    try {
        log.info('=== Forge 元数据更新开始 ===');

        // 步骤 1：获取 Maven XML
        log.info('获取 Maven 元数据...');
        const response = await fetchWithRetry(MAVEN_XML_URL);
        if (!response.ok) {
            throw new NetworkError(`获取 Maven XML 失败: HTTP ${response.status}`, {
                status: response.status,
                url: MAVEN_XML_URL,
            });
        }
        const xmlText = await response.text();
        log.info(`Maven XML 获取成功 (${xmlText.length} 字节)`);

        // 步骤 2：解析版本列表
        const versions = parseVersionsFromXml(xmlText);
        log.info(`解析到 ${versions.length} 个版本`);

        // 步骤 3：读取现有 index.json（缓存机制）
        const existingData = readExistingIndex();
        if (existingData) {
            const processed = Object.values(existingData.number || {}).filter(
                (e) => e.modified > 0
            ).length;
            log.info(`从现有 index.json 读取到 ${processed} 个已处理构建`);
        }

        // 步骤 4：构建 index 数据结构
        const indexData = buildIndexData(versions, existingData);

        // 步骤 5：处理未完成的构建（文件检查 + 时间戳提取）
        const buildsToProcess = Object.values(indexData.number).filter(
            (b) => b.modified === 0
        );
        log.info(`需要处理的构建: ${buildsToProcess.length}`);

        if (buildsToProcess.length > 0) {
            await processConcurrently(buildsToProcess, processBuild);
        }

        // 步骤 6：写入 index.json
        writeFileSync(INDEX_PATH, JSON.stringify(indexData));
        log.info(`index.json 已写入: ${INDEX_PATH}`);

        // 步骤 7：清理旧的缓存文件
        const oldFiles = ['install.json', 'time.json', 'forge-maven-metadata.json', 'forge-maven-metadata.xml'];
        for (const file of oldFiles) {
            const filePath = join(__dirname, file);
            if (existsSync(filePath)) {
                unlinkSync(filePath);
                log.info(`已清理旧缓存文件: ${file}`);
            }
        }

        log.info('=== Forge 元数据更新完成 ===');
    } catch (error) {
        if (error instanceof NetworkError) {
            log.error(`网络错误: ${error.message}`);
        } else if (error instanceof ParseError) {
            log.error(`解析错误: ${error.message}`);
        } else if (error instanceof FileError) {
            log.error(`文件错误: ${error.message}`);
        } else {
            log.error(`未知错误: ${error.message}`);
            log.error(error.stack);
        }
        process.exit(1);
    }
}

// 仅在直接执行时运行（被 import 时不执行）
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main();
}
