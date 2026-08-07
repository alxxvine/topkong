#!/usr/bin/env sh
# Поднять номер сборки веб-версии на единицу.
#
# Номер живёт в двух местах index.html — в window.TK_BUILD и в каждом URL
# карты импортов — и оба обязаны меняться вместе. Если они разойдутся,
# в HUD будет написано одно, а работать будет другое, и весь смысл метки
# пропадёт.
#
# Правим только строки, где номер действительно есть, и не трогаем
# комментарии: попытка сделать это одной sed по всему файлу уже однажды
# переписала сама себя.
#
#   ./docs/bump-build.sh        поднять на единицу
#   ./docs/bump-build.sh 12     поставить конкретный номер

set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
file="$dir/index.html"

current=$(sed -n 's/^<script>window\.TK_BUILD = "\([0-9]*\)".*/\1/p' "$file")
if [ -z "$current" ]; then
  echo "не нашёл window.TK_BUILD в $file" >&2
  exit 1
fi

next=${1:-$((current + 1))}

sed -i \
  -e "s|^<script>window\.TK_BUILD = \"[0-9]*\";</script>|<script>window.TK_BUILD = \"$next\";</script>|" \
  -e "s|\(\"\./[^\"]*\.js\)?v=[0-9]*\"|\1?v=$next\"|" \
  "$file"

echo "сборка $current -> $next"
grep -c "?v=$next\"" "$file" | sed 's/^/модулей в карте: /'
