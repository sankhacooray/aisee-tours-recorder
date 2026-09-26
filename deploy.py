#!/usr/bin/env python3
"""Publish the recorder to GitHub Pages (HTTPS — needed for geolocation on phones).

Shallow-clones the gh-pages branch into a temp dir, wipes it (keeping .git),
copies the static files in, stamps the service-worker cache version, commits and
pushes. Auto-creates gh-pages if missing.

Prerequisites: this folder must be a git repo with an `origin` remote, e.g.
    git init && git add -A && git commit -m init
    git remote add origin git@github.com:<you>/aisee-tours-recorder.git
Then: python3 deploy.py   (optionally set CNAME via env: CNAME=recorder.example.com)
"""
import os, shutil, subprocess, tempfile, time, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = ["index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "sw.js"]
VERSION = time.strftime("%Y%m%d-%H%M%S")


def run(cmd, cwd=None):
    print(">", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def main():
    try:
        origin = subprocess.check_output(["git", "-C", ROOT, "remote", "get-url", "origin"]).decode().strip()
    except subprocess.CalledProcessError:
        sys.exit("No `origin` remote. See the prerequisites in this file's docstring.")

    tmp = tempfile.mkdtemp(prefix="recorder-ghp-")
    try:
        try:
            run(["git", "clone", "--depth", "1", "--branch", "gh-pages", origin, tmp])
        except subprocess.CalledProcessError:
            run(["git", "clone", "--depth", "1", origin, tmp])
            run(["git", "checkout", "--orphan", "gh-pages"], cwd=tmp)
            run(["git", "rm", "-rf", "."], cwd=tmp)

        # Preserve any custom domain already on the branch. deploy.py wipes the
        # tree below, so read the existing CNAME first and default to it when the
        # env var isn't set — otherwise a plain `python3 deploy.py` silently drops
        # the custom domain (aiseecoder.sankhacooray.com) and breaks the URL.
        existing_cname = ""
        cpath = os.path.join(tmp, "CNAME")
        if os.path.exists(cpath):
            with open(cpath) as fh:
                existing_cname = fh.read().strip()

        for n in os.listdir(tmp):
            if n != ".git":
                p = os.path.join(tmp, n)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

        for f in FILES:
            shutil.copy(os.path.join(ROOT, f), os.path.join(tmp, f))

        # Cache-bust the service worker for this deploy.
        swp = os.path.join(tmp, "sw.js")
        with open(swp) as fh:
            sw = fh.read().replace("BUILD_VERSION_PLACEHOLDER", VERSION)
        with open(swp, "w") as fh:
            fh.write(sw)

        # Cache-bust the linked JS/CSS so a new deploy takes effect on the next
        # load. index.html is fetched network-first, so the versioned URLs pull
        # fresh app.js/styles.css from the network instead of the (cache-first)
        # service-worker copy of the previous build.
        idxp = os.path.join(tmp, "index.html")
        with open(idxp) as fh:
            idx = fh.read()
        idx = idx.replace('href="styles.css"', 'href="styles.css?v=%s"' % VERSION)
        idx = idx.replace('src="app.js"', 'src="app.js?v=%s"' % VERSION)
        with open(idxp, "w") as fh:
            fh.write(idx)

        open(os.path.join(tmp, ".nojekyll"), "w").close()
        cname = os.environ.get("CNAME") or existing_cname
        if cname:
            with open(os.path.join(tmp, "CNAME"), "w") as fh:
                fh.write(cname + "\n")

        run(["git", "add", "-A"], cwd=tmp)
        run(["git", "commit", "-m", f"Deploy {VERSION}"], cwd=tmp)
        run(["git", "push", "origin", "gh-pages"], cwd=tmp)
        print(f"\nDeployed {VERSION} to gh-pages.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
