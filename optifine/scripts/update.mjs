#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'index.json');

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const DOWNLOADS_URL = 'https://optifine.net/downloads';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;

// 下载镜像列表
const DOWNLOAD_MIRRORS = [
    'https://of-302-v.8mi.edu.pl/file/',
    'https://of-302-cf.8mi.edu.pl/file/',
    'https://of-302v.zkitefly.eu.org/file/',
    'https://of-302.zkitefly.eu.org/file/',
    'https://of-302v.zkitefly.free.hr/file/',
    'https://of-302.zkitefly.free.hr/file/',
    'https://of-302.burningtnt.workers.dev/file/',
];

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

// ===========================================================================
// HTTP 工具
// ===========================================================================

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 HTTP GET 请求
 * @param {string} url - 请求 URL
 * @param {number} retries - 最大重试次数
 * @returns {Promise<string>} 响应文本
 */
async function fetchText(url, retries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': USER_AGENT },
            });
            clearTimeout(timeout);

            if (!response.ok) {
                throw new NetworkError(`HTTP ${response.status}`, {
                    status: response.status,
                    url,
                });
            }
            return await response.text();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                log.warn(`请求失败 (${attempt}/${retries}): ${url} - ${error.message}，重试中...`);
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    throw new NetworkError(`请求失败（已重试 ${retries} 次）: ${url}`, {
        url,
        cause: lastError,
    });
}

// ===========================================================================
// HTML 解析逻辑（原 main.py 的正则解析）
// ===========================================================================

/**
 * 正则搜索，返回所有匹配结果
 * @param {string} pattern - 正则表达式字符串
 * @param {string} text - 搜索文本
 * @returns {string[]} 匹配结果数组
 */
function regexSearch(pattern, text) {
    const regex = new RegExp(pattern, 'g');
    return [...text.matchAll(regex)].map((m) => m[0]);
}

/**
 * 从 HTML 页面解析版本信息
 *
 * 提取三类数据：
 *   - Forge 兼容版本：colForge 标签内容
 *   - 发布日期：colDate 标签内容
 *   - 文件名：OptiFine_xxx.jar 中的 xxx 部分
 *
 * @param {string} html - HTML 页面内容
 * @returns {{forgeVersions: string[], releaseTimes: string[], names: string[]}} 解析结果
 * @throws {ParseError} 数据不完整或长度不足
 */
export function parseHtmlPage(html) {
    if (html.length < 200) {
        throw new ParseError('获取到的页面内容长度不足', { source: 'html' });
    }

    const forgeVersions = regexSearch("(?<=colForge'>)[^<]*", html);
    const releaseTimes = regexSearch("(?<=colDate'>)[^<]+", html);
    const names = regexSearch("(?<=OptiFine_)[0-9A-Za-z_.]+(?=.jar\")", html);

    log.info(`解析结果: Forge版本 ${forgeVersions.length} 个, 日期 ${releaseTimes.length} 个, 文件名 ${names.length} 个`);

    // 数据完整性校验
    if (releaseTimes.length !== names.length) {
        throw new ParseError(
            `版本与发布时间数据无法对应 (日期: ${releaseTimes.length}, 文件名: ${names.length})`,
            { source: 'html' }
        );
    }
    if (forgeVersions.length !== names.length) {
        throw new ParseError(
            `版本与 Forge 兼容数据无法对应 (Forge: ${forgeVersions.length}, 文件名: ${names.length})`,
            { source: 'html' }
        );
    }
    if (releaseTimes.length < 10) {
        throw new ParseError(
            `获取到的版本数量不足 (${releaseTimes.length} < 10)`,
            { source: 'html' }
        );
    }

    return { forgeVersions, releaseTimes, names };
}

/**
 * 将解析的原始数据构建为版本条目列表
 *
 * 每个条目包含：
 *   - name: 版本名（去除 mcversion 前缀，下划线分隔）
 *   - time: 发布日期（YYYY-MM-DD 格式）
 *   - mcversion: Minecraft 版本号
 *   - filename: 文件名（preview_ 前缀用于预览版）
 *   - forge: 兼容的 Forge 版本
 *
 * @param {string[]} forgeVersions - Forge 兼容版本数组
 * @param {string[]} releaseTimes - 发布日期数组
 * @param {string[]} names - 文件名数组
 * @returns {Array<object>} 版本条目数组
 */
export function buildVersionEntries(forgeVersions, releaseTimes, names) {
    const entries = [];

    for (let i = 0; i < releaseTimes.length; i++) {
        // 替换下划线为空格用于处理
        let name = names[i].replace(/_/g, ' ');

        // 判断是否为预览版
        const isPreview = name.toLowerCase().includes('pre');

        // 提取 mcversion（文件名第一个空格前的部分）
        const mcversion = name.split(' ')[0];

        // 生成文件名
        const filename =
            (isPreview ? 'preview_' : '') +
            'OptiFine_' +
            names[i].replace(/ /g, '_') +
            '.jar';

        // 日期格式转换：DD.MM.YYYY → YYYY-MM-DD
        const time = releaseTimes[i].split('.').reverse().join('-');

        // 生成 name 字段：去除 mcversion 前缀，下划线分隔
        const entryName = names[i].replace(/ /g, '_').replace(mcversion + '_', '');

        entries.push({
            name: entryName,
            time,
            mcversion,
            filename,
            forge: forgeVersions[i],
        });
    }

    return entries;
}

// ===========================================================================
// 数据合并与去重逻辑（原 main.py 的合并 + converter.py 的字段过滤）
// ===========================================================================

/**
 * 读取现有 index.json
 *
 * 优化点：直接使用 index.json 作为数据源，保留 time 字段用于去重和排序，
 * 无需 index-raw.json 中间文件。
 *
 * @returns {object} 现有数据，结构为 { download: [], file: [] }
 */
function readExistingIndex() {
    if (existsSync(INDEX_PATH)) {
        try {
            const content = readFileSync(INDEX_PATH, 'utf-8');
            const data = JSON.parse(content);
            // 确保数据结构完整
            if (!data.download) data.download = [];
            if (!data.file) data.file = [];
            return data;
        } catch (error) {
            log.warn(`读取现有 index.json 失败: ${error.message}，将重新构建`);
        }
    }
    return { download: [], file: [] };
}

/**
 * 合并新旧数据，去重并排序
 *
 * 去重规则：按 filename 去重，保留 time 最新的条目
 * 排序规则：按 time 降序排列
 *
 * @param {Array<object>} existingFiles - 现有文件列表
 * @param {Array<object>} newEntries - 新抓取的条目
 * @returns {Array<object>} 合并去重排序后的文件列表
 */
export function mergeAndDeduplicate(existingFiles, newEntries) {
    // 使用 Map 按 filename 分组，保留 time 最大的条目
    const fileMap = new Map();

    // 先加入现有数据
    for (const file of existingFiles) {
        const existing = fileMap.get(file.filename);
        if (!existing || (file.time && existing.time && file.time > existing.time)) {
            fileMap.set(file.filename, file);
        } else if (!existing) {
            fileMap.set(file.filename, file);
        }
    }

    // 再合并新数据（新数据优先级更高，因为时间更准确）
    for (const entry of newEntries) {
        const existing = fileMap.get(entry.filename);
        if (!existing || (entry.time && (!existing.time || entry.time > existing.time))) {
            fileMap.set(entry.filename, entry);
        }
    }

    // 转换为数组并按 time 降序排序
    const result = [...fileMap.values()];
    result.sort((a, b) => {
        const timeA = a.time || '';
        const timeB = b.time || '';
        return timeB.localeCompare(timeA);
    });

    return result;
}

// ===========================================================================
// 主流程
// ===========================================================================

/**
 * 主函数
 */
async function main() {
    try {
        log.info('=== OptiFine 元数据更新开始 ===');

        // 步骤 1：抓取下载页面
        log.info('抓取 OptiFine 下载页面...');
        const html = await fetchText(DOWNLOADS_URL);
        log.info(`页面抓取成功 (${html.length} 字节)`);

        // 步骤 2：解析 HTML
        const { forgeVersions, releaseTimes, names } = parseHtmlPage(html);

        // 步骤 3：构建版本条目
        const newEntries = buildVersionEntries(forgeVersions, releaseTimes, names);
        log.info(`构建了 ${newEntries.length} 个版本条目`);

        // 步骤 4：读取现有 index.json（直接读取，无需 index-raw.json）
        const existingData = readExistingIndex();
        log.info(`现有 index.json 包含 ${existingData.file.length} 个文件条目`);

        // 步骤 5：合并、去重、排序
        const mergedFiles = mergeAndDeduplicate(existingData.file, newEntries);
        log.info(`合并后共 ${mergedFiles.length} 个文件条目`);

        // 步骤 6：构建输出数据（保留 time 字段用于后续去重排序）
        const outputData = {
            download: DOWNLOAD_MIRRORS,
            file: mergedFiles,
        };

        // 步骤 7：写入 index.json
        writeFileSync(INDEX_PATH, JSON.stringify(outputData));
        log.info(`index.json 已写入: ${INDEX_PATH}`);

        // 步骤 8：清理旧的中间文件
        const oldFiles = ['index-raw.json'];
        for (const file of oldFiles) {
            const filePath = join(__dirname, file);
            if (existsSync(filePath)) {
                unlinkSync(filePath);
                log.info(`已清理旧中间文件: ${file}`);
            }
        }

        log.info('=== OptiFine 元数据更新完成 ===');
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
