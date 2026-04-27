set -ex 

ROOT_DIR=$PWD

cd $ROOT_DIR
pwd

echo DEBUG_1
pnpm install

echo DEBUG_2
ls -al packages/upgrade/node_modules/.cache || true

echo DEBUG_3
pnpm run build --force

echo DEBUG_4
ls -al packages/upgrade/node_modules/.cache || true

echo DEBUG_5
pnpm run typecheck:tests
