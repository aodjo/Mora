#!/usr/bin/env bash
# DGX Spark(aarch64 · GB10 · CUDA 13)에서 CTranslate2 를 CUDA 로 짓는다 — 순서 3/3. — PyPI 의 aarch64 판은 CUDA 없이 지어져
# faster-whisper 가 GPU 를 못 본다. cuDNN 은 없으므로 끈다(Conv1D 는 im2col + cuBLAS 로 돈다).
# 라이브러리는 /usr/local 에 깐다 — 파이썬 확장이 rpath 로 거기를 본다.
set -eu
ROOT=$HOME/mora-gen
W=$ROOT/ct2
VENV=$ROOT/Mora/Generator/.venv
LOG=$W/build.log
mkdir -p "$W"
cd "$W"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
export PATH="$VENV/bin:/usr/local/cuda/bin:$HOME/.local/bin:$PATH" CMAKE_POLICY_VERSION_MINIMUM=3.5

say "도구 (cmake 3 · ninja · pybind11)"
uv pip install -q --python "$VENV/bin/python" "cmake<4" ninja pybind11 setuptools wheel >>"$LOG" 2>&1
[ -d CTranslate2 ] || git clone -q --depth 1 --branch v4.8.2 --recursive --shallow-submodules \
  https://github.com/OpenNMT/CTranslate2.git >>"$LOG" 2>&1

say "설정"
# FindCUDA 의 아키텍처 표는 12.x 를 모른다(「Unknown CUDA Architecture Name 12.1」). GB10 만 짓는다.
sed -i 's|^  cuda_select_nvcc_arch_flags(ARCH_FLAGS ${CUDA_ARCH_LIST})|  set(ARCH_FLAGS "-arch=compute_121")|' CTranslate2/CMakeLists.txt
rm -rf build
cmake -S CTranslate2 -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DWITH_CUDA=ON -DWITH_CUDNN=OFF -DCUDA_DYNAMIC_LOADING=ON -DWITH_MKL=OFF -DWITH_RUY=ON \
  -DOPENMP_RUNTIME=COMP -DCUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda -DCUDA_ARCH_LIST=12.1 -DBUILD_CLI=OFF >>"$LOG" 2>&1

say "짓기 (오래 걸린다)"
cmake --build build -j 8 >>"$LOG" 2>&1
cmake --install build >>"$LOG" 2>&1
ldconfig

say "파이썬 확장"
rm -rf dist
( cd CTranslate2/python && "$VENV/bin/python" -m pip wheel . --no-deps --no-build-isolation -w "$W/dist" >>"$LOG" 2>&1 )
uv pip install -q --python "$VENV/bin/python" --reinstall --no-deps "$W"/dist/ctranslate2-*.whl >>"$LOG" 2>&1
"$VENV/bin/python" -c "import ctranslate2; print('ctranslate2', ctranslate2.__version__, 'cuda devices', ctranslate2.get_cuda_device_count())" 2>&1 | tee -a "$LOG"
say "끝"
echo 끝 > "$W/done"
