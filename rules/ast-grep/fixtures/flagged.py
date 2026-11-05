import os
import pickle
import subprocess

import requests
import yaml


def handle(cmd, data, url, items=[], options: dict = {}):  # expect: python-mutable-default-argument python-mutable-default-argument
    eval(cmd)  # expect: security-python-eval-injection
    exec(cmd)  # expect: security-python-eval-injection
    os.system("ls " + cmd)  # expect: security-python-shell-injection
    subprocess.run(cmd, check=True, shell=True)  # expect: security-python-shell-injection
    pickle.loads(data)  # expect: security-python-unsafe-deserialization
    yaml.load(data)  # expect: security-python-unsafe-deserialization
    requests.get(url, verify=False)  # expect: security-python-tls-verification-disabled
    assert (items, "items must not be empty")  # expect: python-assert-on-tuple
    if options == None:  # expect: python-none-equality
        return None
    try:
        return items[0]
    except:  # expect: python-bare-except
        return None
