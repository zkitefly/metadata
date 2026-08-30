#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'index.json');
const FILES_DIR = join(__dirname, '..', 'files');

const GITHUB_API_URL = 'https://api.github.com/repos/CleanroomMC/Cleanroom/releases?per_page=100';
const DOWNLOAD_BASE_URL = 'https://github.com/CleanroomMC/Cleanroom/releases/download';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;

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
 * 构建 GitHub API 请求头
 * 支持通过 GH_TOKEN 环境变量进行认证
 * @returns {object} 请求头对象
 */
function buildHeaders() {
    const headers = {};
    const ghToken = process.env.GH_TOKEN;
    if (ghToken) {
        headers['Authorization'] = `Bearer ${ghToken}`;
    }
    return headers;
}

/**
 * 带重试的 HTTP 请求（JSON 响应）
 * @param {string} url - 请求 URL
 * @param {object} headers - 请求头
 * @param {number} retries - 最大重试次数
 * @returns {Promise<object>} 解析后的 JSON 数据
 */
async function fetchJson(url, headers = {}, retries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const response = await fetch(url, {
                signal: controller.signal,
                headers,
            });
            clearTimeout(timeout);

            if (!response.ok) {
                throw new NetworkError(`HTTP ${response.status}`, {
                    status: response.status,
                    url,
                });
            }
            return await response.json();
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
// 数据处理逻辑
// ===========================================================================

/**
 * 从 GitHub API 响应中提取所需字段
 *
 * 每个 Release 提取：
 *   - name: Release 名称（版本号）
 *   - created_at: 创建时间（ISO 8601 格式）
 *
 * @param {Array<object>} releases - GitHub API 返回的 Release 数组
 * @returns {Array<object>} 处理后的 Release 信息数组
 */
export function processReleases(releases) {
    return releases.map((release) => ({
        name: release.name,
        created_at: release.created_at,
    }));
}

/**
 * 下载单个 installer.jar 文件
 *
 * 如果文件已存在则跳过。使用流式写入避免内存占用过高。
 *
 * @param {string} releaseName - Release 名称（版本号）
 * @param {string} filesDir - 文件保存目录
 * @returns {Promise<boolean>} 是否实际下载了文件（false 表示已存在或失败）
 */
async function downloadInstaller(releaseName, filesDir) {
    const filename = `cleanroom-${releaseName}-installer.jar`;
    const filePath = join(filesDir, filename);

    // 已存在则跳过
    if (existsSync(filePath)) {
        log.debug(`跳过已存在的文件: ${filename}`);
        return false;
    }

    const downloadUrl = `${DOWNLOAD_BASE_URL}/${releaseName}/${filename}`;
    log.info(`正在下载: ${filename}`);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 分钟超时
        const response = await fetch(downloadUrl, {
            signal: controller.signal,
            redirect: 'follow',
        });
        clearTimeout(timeout);

        if (!response.ok) {
            throw new NetworkError(`HTTP ${response.status}`, {
                status: response.status,
                url: downloadUrl,
            });
        }

        // 流式写入文件
        const writeStream = createWriteStream(filePath);
        await pipeline(response.body, writeStream);

        log.info(`下载完成: ${filename}`);
        return true;
    } catch (error) {
        log.error(`下载 ${filename} 失败: ${error.message}`);
        return false;
    }
}

// ===========================================================================
// 主流程
// ===========================================================================

/**
 * 主函数
 */
async function main() {
    try {
        log.info('=== Cleanroom 元数据更新开始 ===');

        // 步骤 1：获取 GitHub Releases
        log.info('获取 Cleanroom Releases...');
        const headers = buildHeaders();
        const releasesData = await fetchJson(GITHUB_API_URL, headers);
        log.info(`获取到 ${releasesData.length} 个 Release`);

        // 步骤 2：处理 Release 数据
        const releases = processReleases(releasesData);

        // 步骤 3：写入 index.json
        writeFileSync(INDEX_PATH, JSON.stringify(releases));
        log.info(`index.json 已写入: ${INDEX_PATH}`);

        // 步骤 4：下载缺失的 installer 文件
        log.info('检查并下载缺失的 installer 文件...');
        mkdirSync(FILES_DIR, { recursive: true });

        let downloadCount = 0;
        for (const release of releases) {
            const downloaded = await downloadInstaller(release.name, FILES_DIR);
            if (downloaded) downloadCount++;
        }
        log.info(`共下载了 ${downloadCount} 个新文件`);

        log.info('=== Cleanroom 元数据更新完成 ===');
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
