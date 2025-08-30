import os
import json
import requests
from pathlib import Path

def get_releases():
    url = "https://api.github.com/repos/CleanroomMC/Cleanroom/releases"
    headers = {}
    
    # 检查 GH_TOKEN 环境变量
    gh_token = os.getenv('GH_TOKEN')
    if gh_token:
        headers['Authorization'] = f'Bearer {gh_token}'
    
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    
    # 提取所需的字段
    releases = []
    for release in response.json():
        releases.append({
            "name": release["name"],
            "created_at": release["created_at"]
        })
    
    return releases

def save_index(releases):
    # 获取当前脚本所在目录
    current_dir = Path(__file__).parent
    index_path = current_dir / "index.json"
    
    # 保存为 JSON 文件
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(releases, f)

def download_files(releases):
    # 创建 files 目录
    current_dir = Path(__file__).parent
    files_dir = current_dir / "files"
    files_dir.mkdir(exist_ok=True)
    
    for release in releases:
        filename = f"cleanroom-{release['name']}-installer.jar"
        file_path = files_dir / filename
        
        # 如果文件已存在，跳过下载
        if file_path.exists():
            print(f"跳过已存在的文件: {filename}")
            continue
        
        # 构建下载URL
        download_url = f"https://github.com/CleanroomMC/Cleanroom/releases/download/{release['name']}/cleanroom-{release['name']}-installer.jar"
        
        try:
            print(f"正在下载: {filename}")
            response = requests.get(download_url, stream=True)
            response.raise_for_status()
            
            # 下载文件
            with open(file_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            print(f"下载完成: {filename}")
        except Exception as e:
            print(f"下载 {filename} 时出错: {str(e)}")

def main():
    try:
        # 获取releases数据
        releases = get_releases()
        
        # 保存index.json
        save_index(releases)
        
        # 下载文件
        download_files(releases)
        
    except Exception as e:
        print(f"发生错误: {str(e)}")

if __name__ == "__main__":
    main()
