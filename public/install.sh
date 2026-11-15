#!/bin/sh
set -eu

install_subsontime() {
  release_url=${SUBSONTIME_RELEASE_URL:-https://github.com/jspthesixth/subsontime/releases/latest/download}

  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *)
      echo "subsontime: no build for $(uname -s)" >&2
      exit 1
      ;;
  esac

  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *)
      echo "subsontime: no build for $(uname -m)" >&2
      exit 1
      ;;
  esac

  if [ "$os" = linux ] && ls /lib/ld-musl-* > /dev/null 2>&1; then
    os=linux-musl
  fi

  if ! command -v sha256sum > /dev/null && ! command -v shasum > /dev/null; then
    echo "subsontime: install needs sha256sum or shasum to check the download" >&2
    exit 1
  fi

  name=subsontime-$os-$arch
  temp=$(mktemp -d)
  trap 'rm -rf "$temp"' EXIT
  trap 'rm -rf "$temp"; exit 130' INT
  trap 'rm -rf "$temp"; exit 143' TERM

  curl -fsSL -o "$temp/$name" "$release_url/$name"
  curl -fsSL -o "$temp/SHA256SUMS" "$release_url/SHA256SUMS"

  if command -v sha256sum > /dev/null; then
    actual=$(sha256sum "$temp/$name" | cut -d ' ' -f 1)
  else
    actual=$(shasum -a 256 "$temp/$name" | cut -d ' ' -f 1)
  fi

  expected=$(awk -v name="$name" '$2 == name { print $1 }' "$temp/SHA256SUMS")

  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    echo "subsontime: $name does not match SHA256SUMS" >&2
    exit 1
  fi

  bin_dir=/usr/local/bin

  if [ ! -w "$bin_dir" ]; then
    bin_dir=$HOME/.local/bin
    mkdir -p "$bin_dir"
  fi

  chmod +x "$temp/$name"
  mv "$temp/$name" "$bin_dir/subsontime"

  echo "Installed subsontime to $bin_dir/subsontime"

  case :$PATH: in
    *:"$bin_dir":*) ;;
    *) echo "Add $bin_dir to your PATH" ;;
  esac

  if [ "$os" = linux-musl ] && [ ! -e /usr/lib/libstdc++.so.6 ] && [ ! -e /lib/libstdc++.so.6 ]; then
    echo "subsontime needs libstdc++: apk add libstdc++"
  fi

  echo
  echo "As Bazarr's post-processing command:"
  echo "subsontime bazarr --video {{episode}} --subtitle {{subtitles}} --lang {{subtitles_language_code3}}"
}

install_subsontime
