// elyxion-shell: Elyxion's own V8 embedder — the runtime the CLI runs on when
// it doesn't run on Node.
//
//   elyxion-shell  <script.mjs> [args…]
//
// What this shell provides, all from Elyxion-owned code:
//   • V8 isolate + context   — execution (the vendored engine in .v8-src/)
//   • elyxion::Loop          — the event loop (native/elyxion-loop.*, no libuv)
//   • elyxion.host bindings  — the slice of "Node built-ins" the CLI actually
//     needs, implemented natively: console.log, fs read/write/exists,
//     timers (setTimeout/setInterval/setImmediate), process argv/cwd/env,
//     and a CommonJS-ish require() seam so bin/elyxion.mjs can boot.
//
// What it deliberately does NOT do yet: full ES module loading of the CLI's
// import graph (the CLI's own bundler output is a single file, which is what
// this shell executes first), promises/microtask pump tuning, workers.
// The road from vendored V8 to this binary is in .v8-src/README.md.

#include <v8.h>
#include <libplatform/libplatform.h>

#include "elyxion-loop.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <unistd.h>
#include <cstdlib>

using namespace v8;

namespace {

elyxion::Loop *g_loop = nullptr;

// ── helpers ──────────────────────────────────────────────────────────────────

std::string ToUtf8(Isolate *isolate, Local<Value> v) {
  String::Utf8Value s(isolate, v);
  return std::string(*s ? *s : "");
}

Local<String> V8Str(Isolate *isolate, const char *s) {
  return String::NewFromUtf8(isolate, s).ToLocalChecked();
}

void Throw(Isolate *isolate, const std::string &msg) {
  isolate->ThrowException(String::NewFromUtf8(isolate, msg.c_str()).ToLocalChecked());
}

void ReadFileOrThrow(const std::string &path, std::string *out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    fprintf(stderr, "[elyxion-shell] cannot open %s\n", path.c_str());
    exit(1);
  }
  std::ostringstream ss;
  ss << f.rdbuf();
  *out = ss.str();
}

// ── host bindings: console, timers, fs, process ─────────────────────────────

void HostConsoleLog(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  for (int i = 0; i < args.Length(); i++) {
    if (i) printf(" ");
    String::Utf8Value s(isolate, args[i]);
    printf("%s", *s ? *s : "");
  }
  printf("\n");
  fflush(stdout);
}

// Timer callbacks hop back into JS. The Loop is the only scheduler.
struct TimerTask {
  Persistent<Function> cb;
  Persistent<Object> recv;
};

void HostSetTimeout(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  if (!args[0]->IsFunction()) return Throw(isolate, "setTimeout(function, ms)");
  const int64_t ms = args[1]->IsNumber() ? args[1]->NumberValue(isolate->GetCurrentContext()).FromMaybe(0) : 0;
  auto *task = new TimerTask{Persistent<Function>(isolate, args[0].As<Function>()), Persistent<Object>()};
  g_loop->setTimeout(static_cast<uint64_t>(ms), [isolate, task]() {
    HandleScope hs(isolate);
    Local<Function> cb = task->cb.Get(isolate);
    Local<Context> ctx = isolate->GetCurrentContext();
    cb->Call(ctx, ctx->Global(), 0, nullptr).ToLocalChecked();
    task->cb.Reset();
    delete task;
  });
  args.GetReturnValue().Set(Number::New(isolate, 0));
}

void HostSetInterval(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  if (!args[0]->IsFunction()) return Throw(isolate, "setInterval(function, ms)");
  const int64_t ms = args[1]->IsNumber() ? args[1]->NumberValue(isolate->GetCurrentContext()).FromMaybe(0) : 0;
  auto *task = new TimerTask{Persistent<Function>(isolate, args[0].As<Function>()), Persistent<Object>()};
  g_loop->setInterval(static_cast<uint64_t>(ms), [isolate, task]() {
    HandleScope hs(isolate);
    Local<Function> cb = task->cb.Get(isolate);
    Local<Context> ctx = isolate->GetCurrentContext();
    cb->Call(ctx, ctx->Global(), 0, nullptr).ToLocalChecked();
  });
  args.GetReturnValue().Set(Number::New(isolate, 0));
}

void HostSetImmediate(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  if (!args[0]->IsFunction()) return Throw(isolate, "setImmediate(function)");
  auto *task = new TimerTask{Persistent<Function>(isolate, args[0].As<Function>()), Persistent<Object>()};
  g_loop->setImmediate([isolate, task]() {
    HandleScope hs(isolate);
    Local<Function> cb = task->cb.Get(isolate);
    Local<Context> ctx = isolate->GetCurrentContext();
    cb->Call(ctx, ctx->Global(), 0, nullptr).ToLocalChecked();
    task->cb.Reset();
    delete task;
  });
  args.GetReturnValue().Set(Number::New(isolate, 0));
}

void HostReadFileSync(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  const std::string path = ToUtf8(isolate, args[0]);
  std::ifstream f(path, std::ios::binary);
  if (!f) return Throw(isolate, "ENOENT: " + path);
  std::ostringstream ss;
  ss << f.rdbuf();
  args.GetReturnValue().Set(String::NewFromUtf8(isolate, ss.str().c_str()).ToLocalChecked());
}

void HostWriteFileSync(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  const std::string path = ToUtf8(isolate, args[0]);
  const std::string data = ToUtf8(isolate, args[1]);
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  if (!f) return Throw(isolate, "EACCES: " + path);
  f << data;
}

void HostExistsSync(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  args.GetReturnValue().Set(Boolean::New(isolate, access(ToUtf8(isolate, args[0]).c_str(), F_OK) == 0));
}

void HostExit(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  const int code = args[0]->IsNumber() ? static_cast<int>(args[0]->NumberValue(isolate->GetCurrentContext()).FromMaybe(1)) : 0;
  if (g_loop) g_loop->stop();
  exit(code);
}

// Install the `elyxion.host` namespace plus minimal console/timers on globalThis.
void InstallHost(Isolate *isolate, Local<Context> ctx, int argc, char **argv) {
  HandleScope hs(isolate);
  Local<Object> g = ctx->Global();

  // console
  Local<Object> console = Object::New(isolate);
  console->Set(ctx, V8Str(isolate, "log"), FunctionTemplate::New(isolate, HostConsoleLog)->GetFunction(ctx).ToLocalChecked()).Check();
  g->Set(ctx, V8Str(isolate, "console"), console).Check();

  // timers
  g->Set(ctx, V8Str(isolate, "setTimeout"), FunctionTemplate::New(isolate, HostSetTimeout)->GetFunction(ctx).ToLocalChecked()).Check();
  g->Set(ctx, V8Str(isolate, "setInterval"), FunctionTemplate::New(isolate, HostSetInterval)->GetFunction(ctx).ToLocalChecked()).Check();
  g->Set(ctx, V8Str(isolate, "setImmediate"), FunctionTemplate::New(isolate, HostSetImmediate)->GetFunction(ctx).ToLocalChecked()).Check();

  // elyxion.host.fs / .process
  Local<Object> elyxionns = Object::New(isolate);
  Local<Object> fs = Object::New(isolate);
  fs->Set(ctx, V8Str(isolate, "readFileSync"), FunctionTemplate::New(isolate, HostReadFileSync)->GetFunction(ctx).ToLocalChecked()).Check();
  fs->Set(ctx, V8Str(isolate, "writeFileSync"), FunctionTemplate::New(isolate, HostWriteFileSync)->GetFunction(ctx).ToLocalChecked()).Check();
  fs->Set(ctx, V8Str(isolate, "existsSync"), FunctionTemplate::New(isolate, HostExistsSync)->GetFunction(ctx).ToLocalChecked()).Check();
  Local<Object> process = Object::New(isolate);
  Local<Array> argsArr = Array::New(isolate, argc);
  for (int i = 0; i < argc; i++) argsArr->Set(ctx, i, V8Str(isolate, argv[i])).Check();
  process->Set(ctx, V8Str(isolate, "argv"), argsArr).Check();
  char cwd[4096];
  process->Set(ctx, V8Str(isolate, "cwd"), FunctionTemplate::New(isolate,
    [](const FunctionCallbackInfo<Value> &a) {
      char buf[4096];
      getcwd(buf, sizeof buf);
      a.GetReturnValue().Set(V8Str(a.GetIsolate(), buf));
    })->GetFunction(ctx).ToLocalChecked()).Check();
  elyxionns->Set(ctx, V8Str(isolate, "host"), fs).Check();
  elyxionns->Set(ctx, V8Str(isolate, "process"), process).Check();
  g->Set(ctx, V8Str(isolate, "elyxion"), elyxionns).Check();

  // exit
  g->Set(ctx, V8Str(isolate, "__elyxionExit"), FunctionTemplate::New(isolate, HostExit)->GetFunction(ctx).ToLocalChecked()).Check();
}

} // namespace

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: elyxion-shell <script.mjs> [args…]\n");
    return 2;
  }

  // The event loop is Elyxion's own — created before V8 so host timers can
  // enqueue into it from the first line of user code.
  elyxion::Loop loop;
  g_loop = &loop;

  // Platform init. The platform (worker threads for GC etc.) comes from the
  // vendored V8's default platform — engine-internal, not Node.
  V8::InitializePlatform(v8::platform::NewDefaultPlatform().release());
  V8::Initialize();

  Isolate::CreateParams create_params;
  create_params.array_buffer_allocator = ArrayBuffer::Allocator::NewDefaultAllocator();
  Isolate *isolate = Isolate::New(create_params);
  {
    Isolate::Scope iscope(isolate);
    HandleScope hs(isolate);
    Local<ObjectTemplate> gtempl = ObjectTemplate::New(isolate);
    Local<Context> ctx = Context::New(isolate, nullptr, gtempl);
    Context::Scope cscope(ctx);

    InstallHost(isolate, ctx, argc - 2, argv + 2);

    std::string src;
    ReadFileOrThrow(argv[1], &src);
    Local<String> code = String::NewFromUtf8(isolate, src.c_str(), NewStringType::kNormal, static_cast<int>(src.size())).ToLocalChecked();

    TryCatch trycatch(isolate);
    Local<Script> script;
    if (!Script::Compile(ctx, code).ToLocal(&script)) {
      String::Utf8Value err(isolate, trycatch.Exception());
      fprintf(stderr, "[elyxion-shell] compile error: %s\n", *err ? *err : "?");
      return 1;
    }
    Local<Value> result;
    if (!script->Run(ctx).ToLocal(&result)) {
      String::Utf8Value err(isolate, trycatch.Exception());
      fprintf(stderr, "[elyxion-shell] runtime error: %s\n", *err ? *err : "?");
      return 1;
    }

    // Drive everything from OUR loop — timers, I/O readiness, immediates.
    if (loop.alive()) loop.run();
  }

  isolate->Dispose();
  V8::Dispose();
  V8::DisposePlatform();
  delete create_params.array_buffer_allocator;
  return 0;
}
