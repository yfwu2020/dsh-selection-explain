/*
 * dsh-selection-explain · 麦克风占用探针（macOS 14.4+）
 *
 * 回答一个问题：**现在是谁在采集麦克风？**（比如"豆包输入法是不是正在语音输入"）
 *
 * 为什么用 CoreAudio 的进程对象列表，而不是别的办法：
 *   · `kAudioDevicePropertyDeviceIsRunningSomewhere`（设备级）只说"有东西在录"，
 *     不说是谁；而且它挂在具体的 device object 上，换设备/聚合设备时读到的是另一个对象
 *     （实测：ffmpeg 录着音，默认输入设备的这个属性仍是 0）；
 *   · 菜单栏那个橙点同理，只表示"有人在录"。
 *   · 读这个状态**不需要麦克风 TCC 授权**（只有真正录音才需要）。
 *
 * macOS 14.4 起 CoreAudio 暴露了进程对象：`kAudioHardwarePropertyProcessObjectList`
 * 里每个对象都能读 `kAudioProcessPropertyPID` / `kAudioProcessPropertyBundleID` /
 * `kAudioProcessPropertyIsRunningInput` —— 于是"谁在录"变成一次精确查询。
 *
 * 输出协议（每行一个 JSON，状态变化时才输出；`--once` 则只输出一行就退出）：
 *   {"capturing":true,"processes":[{"pid":513,"bundleId":"com.bytedance.inputmethod.doubaoime","name":"DoubaoIme"}]}
 *   {"capturing":false,"processes":[]}
 *
 * 用法：
 *   mic-probe --once              读一次，打印一行，退出
 *   mic-probe --watch [intervalMs]  常驻，状态变化时打印（默认 250ms 一轮）
 *
 * 编不出来 / 非 macOS 时整个功能降级（host 报 available:false），不影响其它功能。
 */
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_PROCS 32

typedef struct {
  pid_t pid;
  char bundle[256];
  char name[128];
} MicProc;

static AudioObjectPropertyAddress propAddr(AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress addr;
  addr.mSelector = selector;
  addr.mScope = kAudioObjectPropertyScopeGlobal;
  addr.mElement = kAudioObjectPropertyElementMain;
  return addr;
}

/** JSON 字符串转义：bundle id / 进程名理论上都很干净，但仍然不拼裸串。 */
static void jsonEscape(const char *src, char *dst, size_t n) {
  size_t j = 0;
  for (size_t i = 0; src[i] && j + 2 < n; i++) {
    unsigned char c = (unsigned char)src[i];
    if (c == '"' || c == '\\') {
      dst[j++] = '\\';
      dst[j++] = (char)c;
    } else if (c < 0x20) {
      dst[j++] = ' ';
    } else {
      dst[j++] = (char)c;
    }
  }
  dst[j] = 0;
}

/** 采集一次：谁正在 running input。返回采集到的进程数。 */
static int scan(MicProc *out, int max) {
  int count = 0;
  AudioObjectPropertyAddress list = propAddr(kAudioHardwarePropertyProcessObjectList);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &list, 0, NULL, &size) != noErr) return 0;
  int total = (int)(size / sizeof(AudioObjectID));
  if (total <= 0) return 0;
  AudioObjectID *objects = (AudioObjectID *)calloc((size_t)total, sizeof(AudioObjectID));
  if (!objects) return 0;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &list, 0, NULL, &size, objects) != noErr) {
    free(objects);
    return 0;
  }
  for (int i = 0; i < total && count < max; i++) {
    UInt32 running = 0;
    UInt32 runningSize = sizeof(running);
    AudioObjectPropertyAddress input = propAddr(kAudioProcessPropertyIsRunningInput);
    if (AudioObjectGetPropertyData(objects[i], &input, 0, NULL, &runningSize, &running) != noErr) continue;
    if (!running) continue;

    MicProc entry;
    memset(&entry, 0, sizeof(entry));
    UInt32 pidSize = sizeof(entry.pid);
    AudioObjectPropertyAddress pidProp = propAddr(kAudioProcessPropertyPID);
    if (AudioObjectGetPropertyData(objects[i], &pidProp, 0, NULL, &pidSize, &entry.pid) != noErr) continue;

    CFStringRef bundle = NULL;
    UInt32 bundleSize = sizeof(bundle);
    AudioObjectPropertyAddress bundleProp = propAddr(kAudioProcessPropertyBundleID);
    if (AudioObjectGetPropertyData(objects[i], &bundleProp, 0, NULL, &bundleSize, &bundle) == noErr && bundle) {
      CFStringGetCString(bundle, entry.bundle, (CFIndex)sizeof(entry.bundle), kCFStringEncodingUTF8);
      CFRelease(bundle);
    }
    // 进程名：没有 bundle id 的命令行程序（ffmpeg 之类）靠它认人
    if (proc_name(entry.pid, entry.name, (uint32_t)sizeof(entry.name)) <= 0) entry.name[0] = 0;

    out[count++] = entry;
  }
  free(objects);
  return count;
}

static void emit(const MicProc *procs, int count) {
  char bundle[512];
  char name[256];
  printf("{\"capturing\":%s,\"processes\":[", count > 0 ? "true" : "false");
  for (int i = 0; i < count; i++) {
    jsonEscape(procs[i].bundle, bundle, sizeof(bundle));
    jsonEscape(procs[i].name, name, sizeof(name));
    printf("%s{\"pid\":%d,\"bundleId\":\"%s\",\"name\":\"%s\"}", i ? "," : "", (int)procs[i].pid, bundle, name);
  }
  printf("]}\n");
  fflush(stdout);
}

/** 状态是否变了（进程集合 + 各自的 bundle/name 都算）。 */
static int changed(const MicProc *a, int an, const MicProc *b, int bn) {
  if (an != bn) return 1;
  for (int i = 0; i < an; i++) {
    if (a[i].pid != b[i].pid) return 1;
    if (strcmp(a[i].bundle, b[i].bundle) != 0) return 1;
    if (strcmp(a[i].name, b[i].name) != 0) return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  int watch = 0;
  int intervalMs = 250;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--once") == 0) watch = 0;
    else if (strcmp(argv[i], "--watch") == 0) watch = 1;
    else {
      int parsed = atoi(argv[i]);
      if (parsed >= 50 && parsed <= 5000) intervalMs = parsed;
    }
  }

  MicProc current[MAX_PROCS];
  MicProc previous[MAX_PROCS];
  int previousCount = -1;

  for (;;) {
    int count = scan(current, MAX_PROCS);
    if (!watch || changed(current, count, previous, previousCount)) emit(current, count);
    memcpy(previous, current, sizeof(MicProc) * (size_t)count);
    previousCount = count;
    if (!watch) return 0;
    usleep((useconds_t)intervalMs * 1000);
  }
}
