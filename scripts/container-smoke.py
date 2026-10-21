"""Exercise the shipped image with a retained volume and no published ports."""
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

image = sys.argv[1]
name = f"pr-lens-smoke-{uuid.uuid4().hex}"
volume = f"{name}-data"
environment = {**os.environ, "PUBLISH_TOKEN": secrets.token_hex(32)}


def docker(*args, payload=None):
    return subprocess.run(
        ["docker", *args], input=payload, text=True, capture_output=True,
        check=True, timeout=120, env=environment,
    ).stdout.strip()


def start():
    docker("run", "--detach", "--name", name, "--read-only", "--tmpfs", "/tmp",
           "--mount", f"type=volume,source={volume},target=/data",
           "--env", "PUBLISH_TOKEN", "--env", "PUBLIC_ORIGIN=http://localhost:8080", image)
    for _ in range(30):
        result = subprocess.run(
            ["docker", "exec", name, "bun", "-e",
             'if(!(await fetch("http://127.0.0.1:8080/healthz")).ok)process.exit(1)'],
            capture_output=True, timeout=10,
        )
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("The production container did not become ready")


probe = """
const input = JSON.parse(await Bun.stdin.text());
const root = 'http://127.0.0.1:8080';
if (input.action === 'publish') {
  const headers = {'content-type':'application/json', 'X-PR-Lens-Publish-Token':process.env.PUBLISH_TOKEN};
  const minted = await fetch(root+'/api/canvas', {method:'POST',headers});
  if (minted.status !== 201) throw new Error('Mint failed');
  const canvas = await minted.json();
  const pushed = await fetch(root+'/api/canvas/'+canvas.id, {method:'PUT',
    headers:{...headers,authorization:'Bearer '+canvas.writeToken,'if-match':'0'},body:JSON.stringify(input.document)});
  if (!pushed.ok) throw new Error('Publish failed');
  console.log(JSON.stringify({id:canvas.id}));
} else {
  const response = await fetch(root+'/api/canvas/'+input.id);
  if (!response.ok) throw new Error('Read failed');
  const canvas = await response.json();
  console.log(JSON.stringify({title:canvas.document.title,rev:canvas.rev}));
}
"""

try:
    docker("volume", "create", volume)
    start()
    document = json.loads((Path(__file__).resolve().parents[1] / "packages/schema/examples/minimal.graph.json").read_text())
    published = json.loads(docker("exec", "--interactive", name, "bun", "-e", probe,
                                  payload=json.dumps({"action": "publish", "document": document})))
    docker("kill", name)
    docker("rm", name)
    start()
    restored = json.loads(docker("exec", "--interactive", name, "bun", "-e", probe,
                                 payload=json.dumps({"action": "read", "id": published["id"]})))
    assert restored == {"title": document["title"], "rev": 1}, restored
    print("Production container publishes and recovers its retained SQLite volume after SIGKILL")
finally:
    subprocess.run(["docker", "rm", "--force", name], capture_output=True, timeout=30)
    subprocess.run(["docker", "volume", "rm", volume], capture_output=True, timeout=30)
