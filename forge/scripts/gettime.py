import json
import os
import requests
import zipfile
from datetime import datetime, timezone
from dateutil import parser as date_parser
from concurrent.futures import ThreadPoolExecutor, as_completed

# 读取现有的 time.json 文件，如果存在的话
if os.path.exists('time.json'):
    with open('time.json', 'r') as f:
        saved_times = json.load(f)
else:
    saved_times = []

# 初始化存储时间信息的列表
time_entries = saved_times.copy()

# 读取 index.json 文件
with open('index.json', 'r') as f:
    data = json.load(f)

# 设置 User-Agent 模拟浏览器请求
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36'
}

# 定义处理单个条目的函数
def process_entry(key, entry):
    branch = entry.get('branch')
    mcversion = entry.get('mcversion')
    version = entry.get('version')
    build = entry.get('build')
    files = entry.get('files', [])

    # 判断文件类型，支持 installer.jar / universal.zip / client.zip
    file_type = None
    if any(file_pair == ["jar", "installer"] for file_pair in files):
        file_type = "installer"
    elif any(file_pair == ["zip", "universal"] for file_pair in files):
        file_type = "universal"
    elif any(file_pair == ["zip", "client"] for file_pair in files):
        file_type = "client"
    else:
        print(f"Build {build} with version {version} does not have a supported file combination. Skipping...")
        return

    # 检查是否已存在该版本的时间信息
    if any(t['build'] == build and t['version'] == version for t in saved_times):
        print(f"Build {build} with version {version} already exists in time.json. Skipping...")
        return

    # 组合下载链接和本地文件名
    base_url = "https://maven.minecraftforge.net/net/minecraftforge/forge"
    if file_type == "installer":
        ext = "jar"
        suffix = "-installer"
        file_name = f'installer_{build}.jar'
    elif file_type == "universal":
        ext = "zip"
        suffix = "-universal"
        file_name = f'universal_{build}.zip'
    else:  # client
        ext = "zip"
        suffix = "-client"
        file_name = f'client_{build}.zip'

    if branch:
        url = f"{base_url}/{mcversion}-{version}-{branch}/forge-{mcversion}-{version}-{branch}{suffix}.{ext}"
    else:
        url = f"{base_url}/{mcversion}-{version}/forge-{mcversion}-{version}{suffix}.{ext}"

    # 下载文件（增加 timeout=30 防止卡住）
    print(f"Downloading {file_name} from {url}...")
    try:
        response = requests.get(url, headers=headers, timeout=30)
    except requests.exceptions.RequestException as e:
        print(f"Failed to download {file_name}. Network error: {e}")
        return

    if response.status_code == 200:
        with open(file_name, 'wb') as f:
            f.write(response.content)
    else:
        print(f"Failed to download {file_name}. HTTP Status Code: {response.status_code}")
        return

    # 解压缩文件，按优先级提取时间戳
    time = None
    try:
        with zipfile.ZipFile(file_name, 'r') as jar_file:
            # 1. 查找 version.json
            if 'version.json' in jar_file.namelist():
                with jar_file.open('version.json') as f:
                    version_data = json.load(f)
                    time_str = version_data.get('time', None)
                    if time_str:
                        try:
                            time = int(date_parser.parse(time_str).timestamp())
                        except ValueError:
                            print(f"Failed to parse time string '{time_str}' in version.json")

            # 2. 查找 install_profile.json
            if not time and 'install_profile.json' in jar_file.namelist():
                with jar_file.open('install_profile.json') as f:
                    install_data = json.load(f)
                    version_info = install_data.get('versionInfo', {})
                    time_str = version_info.get('time', None)
                    if time_str:
                        try:
                            time = int(date_parser.parse(time_str).timestamp())
                        except ValueError:
                            print(f"Failed to parse time string '{time_str}' in install_profile.json")

            # 3. 查找 fmlversion.properties，使用 ZIP 条目时间戳
            if not time and 'fmlversion.properties' in jar_file.namelist():
                try:
                    zip_info = jar_file.getinfo('fmlversion.properties')
                    dt = datetime(*zip_info.date_time, tzinfo=timezone.utc)
                    time = int(dt.timestamp())
                    print(f"Using fmlversion.properties timestamp for build {build}: {time}")
                except Exception as e:
                    print(f"Failed to get timestamp from fmlversion.properties for build {build}: {e}")

            # 4. 查找 mod_MinecraftForge.class，使用 ZIP 条目时间戳
            if not time:
                for name in jar_file.namelist():
                    if name.endswith('mod_MinecraftForge.class'):
                        try:
                            zip_info = jar_file.getinfo(name)
                            dt = datetime(*zip_info.date_time, tzinfo=timezone.utc)
                            time = int(dt.timestamp())
                            print(f"Using {name} timestamp for build {build}: {time}")
                        except Exception as e:
                            print(f"Failed to get timestamp from {name} for build {build}: {e}")
                        break

    except (zipfile.BadZipFile, json.JSONDecodeError) as e:
        print(f"Error reading or parsing ZIP file: {e}")
        os.remove(file_name)
        print(f"{file_name} has been deleted (bad zip).")
        return

    # 保存当前条目的时间信息
    if time:
        time_entry = {
            'time': time,
            'build': build,
            'version': version
        }
        time_entries.append(time_entry)

        # 立即将时间信息保存到 time.json
        with open('time.json', 'w') as f:
            json.dump(time_entries, f)
    else:
        print(f"No timestamp found for build {build} with version {version}.")

    # 删除下载的文件
    os.remove(file_name)
    print(f"{file_name} has been deleted.")

# 使用多线程处理所有条目
with ThreadPoolExecutor(max_workers=20) as executor:
    futures = [executor.submit(process_entry, key, entry) for key, entry in data['number'].items()]

    for future in as_completed(futures):
        try:
            future.result()
        except Exception as e:
            print(f"Thread raised an exception: {e}")

# 所有数据收集完毕后，读取 time.json 并更新 index.json
if os.path.exists('time.json'):
    with open('time.json', 'r') as f:
        time_data = json.load(f)

    # 遍历 time.json 中的条目并更新 index.json
    for entry in time_data:
        build = entry['build']
        version = entry['version']
        unix_timestamp = entry['time']

        # 在 index.json 中找到对应条目并更新 modified 属性
        for key, list_entry in data['number'].items():
            if list_entry['build'] == build and list_entry['version'] == version:
                list_entry['modified'] = unix_timestamp
                break

    # 保存更新后的 index.json 文件
    with open('index.json', 'w') as f:
        json.dump(data, f)

    print("Modified times have been updated and saved to index.json.")
else:
    print("No time.json found, nothing to update.")
