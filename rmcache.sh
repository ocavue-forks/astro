function rmcache {
  find . \( \
    -name ".eslintcache" -o \
    -name ".next" -o \
    -name ".swc" -o \
    -name ".turbo" -o \
    -name ".mypy_cache" -o \
    -name ".svelte2tsx-language-server-files" -o \
    -path "*/node_modules/.vite" -o \
    -path "*/node_modules/.cache" -o \
    -path "*/node_modules/.astro" \
  \) -prune -print -exec rm -rf {} +
}

rmcache
