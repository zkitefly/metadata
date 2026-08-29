import json
import time
import requests
from concurrent.futures import ThreadPoolExecutor

MAX_RETRIES = 3
RETRY_DELAY = 2

# 浏览器 User-Agent 示例
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"

# 读取 index.json 文件
with open('index.json', 'r') as f:
    data = json.load(f)

# 尝试读取 install.json 文件，如果不存在就创建一个空列表
try:
    with open('install.json', 'r') as f:
        install_data = json.load(f)
except FileNotFoundError:
    install_data = []

# 忽略旧格式缓存，使其按 files 字段重新探测
install_data = [item for item in install_data if 'files' in item]

# 创建一个字典，方便检查某个 build 是否已经处理过
install_data_dict = {item['build']: item for item in install_data}

# 构造下载 URL 并检查资源是否存在
def check_url(build_info):
    build = build_info['build']

    # 如果 install.json 已经包含这个 build，跳过处理
    if build in install_data_dict:
        print(f"Build {build} already processed, skipping...")
        return None

    branch = build_info.get('branch')
    mcversion = build_info['mcversion']
    version = build_info['version']
    files = build_info.get('files', [])

    base_url = f"https://maven.minecraftforge.net/net/minecraftforge/forge/{mcversion}-{version}"
    if branch:
        base_url += f"-{branch}"
    base_url += f"/forge-{mcversion}-{version}"
    if branch:
        base_url += f"-{branch}"

    headers = {
        'User-Agent': USER_AGENT
    }
    available_files = []

    for extension, classifier in files:
        resource = f"{classifier}.{extension}"
        url = f"{base_url}-{resource}"
        available = False
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = requests.head(
                    url,
                    headers=headers,
                    timeout=(10, 30)
                )
                available = response.status_code != 404
                break
            except requests.RequestException as error:
                last_error = error
                if attempt < MAX_RETRIES:
                    print(
                        f"Build {build}, resource: {resource}, "
                        f"request failed ({attempt}/{MAX_RETRIES}), retrying..."
                    )
                    time.sleep(RETRY_DELAY)

        if available:
            available_files.append([extension, classifier])
            print(
                f"Processed build {build}, resource: {resource}, "
                f"available: True"
            )
        else:
            print(
                f"Processed build {build}, resource: {resource}, "
                f"available: False, error: {last_error}"
            )

    result = {
        'build': build,
        'version': version,
        'files': available_files
    }

    # 实时将结果保存到 install.json
    install_data.append(result)
    with open('install.json', 'w') as f:
        json.dump(install_data, f)

    return result

# 使用多线程处理 URL 检查
with ThreadPoolExecutor() as executor:
    executor.map(check_url, data['number'].values())

# 根据探测结果更新 index.json 中的文件信息
for item in install_data:
    build = str(item['build'])
    if build in data['number'] and 'files' in item:
        data['number'][build]['files'] = item['files']

# 将更新后的 index.json 写回文件
with open('index.json', 'w') as f:
    json.dump(data, f)
