import json
import subprocess

import requests
import yaml


def handle(cmd, data, url, items=None, options: dict | None = None):
    subprocess.run(["ls", cmd], check=True)
    subprocess.run(cmd, shell=False)
    json.loads(data)
    yaml.safe_load(data)
    yaml.load(data, Loader=yaml.SafeLoader)
    yaml.load(data, Loader=CSafeLoader)
    yaml.load_all(data, yaml.BaseLoader)
    requests.get(url, verify=True)
    assert items, "items must not be empty"
    if options is None:
        return None
    try:
        return items[0]
    except (IndexError, TypeError):
        return None
