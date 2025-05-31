import json
import requests
from pathlib import Path
from datetime import datetime, timezone

def fetch_json(url):
    """从URL获取JSON数据"""
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"获取数据时出错: {e}")
        return None

def create_directories():
    """创建必要的目录"""
    Path("versions").mkdir(exist_ok=True)

def save_json(data, filepath, version_id=None):
    """保存JSON数据到文件"""
    try:
        if version_id and isinstance(data, dict):
            # 更新 id 字段
            data["id"] = version_id
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        print(f"已保存: {filepath}")
    except Exception as e:
        print(f"保存文件时出错: {e}")

def main():
    # 创建目录
    create_directories()
    
    # 获取主清单
    manifest_url = "https://releases.r2.labymod.net/api/v1/manifest/production/latest.json"
    manifest_data = fetch_json(manifest_url)
    
    if not manifest_data:
        return
    
    # 提取LabyMod版本
    laby_version = manifest_data.get("labyModVersion")
    
    # 创建索引数据
    index_data = {
        "versions": []
    }
    
    # 处理每个Minecraft版本
    for version_info in manifest_data.get("minecraftVersions", []):
        mc_version = version_info.get("version")
        manifest_url = version_info.get("customManifestUrl")
        
        if mc_version and manifest_url:
            version_id = f"LabyMod-{laby_version}-{mc_version}"
            
            # 下载并保存版本清单
            version_data = fetch_json(manifest_url)
            if version_data:
                version_time = version_data.get("time")
                version_release_time = version_data.get("releaseTime")
                version_type = version_data.get("type")
                
                # 添加到索引，包含时间信息
                index_data["versions"].append({
                    "id": version_id,
                    "type": version_type,
                    "path": f"versions/{version_id}.json",
                    "time": version_time,
                    "releaseTime": version_release_time
                })
                
                version_filepath = f"versions/{version_id}.json"
                save_json(version_data, version_filepath, version_id)
    
    # 保存索引文件
    save_json(index_data, "index.json")

if __name__ == "__main__":
    main()