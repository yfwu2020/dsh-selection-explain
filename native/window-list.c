/*
 * dsh-selection-explain · 窗口列表探针（纯 C + CoreFoundation）
 *
 * 干什么：把"当前屏幕上所有窗口"的名字与矩形打成一个 JSON 数组。
 * 为什么需要它：截图提问要"带出整窗" —— 用户框了一块，我们要知道**那块属于哪个窗口**，
 * 才能把整个窗口截下来（而不是裁一圈边框）。Node 没有 CoreGraphics 绑定，所以编一个小二进制。
 * 与本包 native/mic-probe.c 同一套办法：纯 C、无 ObjC、出错就整体降级。
 *
 * 输出（一行 JSON，数组顺序即前后顺序，前一个更靠前）：
 *   [{"id":123,"x":0,"y":25,"w":1200,"h":800,"layer":0,"alpha":1.00,"owner":"Code"}, ...]
 *
 * 约定：
 *   · 只列 on-screen、非桌面元素的窗口；宽或高 < 8 的丢掉（菜单残片、零尺寸辅助窗口）；
 *   · layer 0 是普通应用窗口（菜单栏/悬浮窗/状态栏都在别的层）；
 *   · 坐标是**全局点**（左上角原点 = 主屏左上角），与截图文件里那个矩形同一套坐标系。
 */
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>

/** JSON 字符串转义：owner 里可能出现引号/反斜杠（罕见，但别拼坏 JSON）。 */
static void jsonEscape(const char *src, char *dst, size_t n) {
  size_t j = 0;
  for (size_t i = 0; src && src[i] && j + 2 < n; i++) {
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
  dst[j] = '\0';
}

/** CFNumber → double，失败给 fallback。 */
static double numOr(CFDictionaryRef dict, CFStringRef key, double fallback) {
  CFTypeRef v = CFDictionaryGetValue(dict, key);
  double out = fallback;
  if (v && CFGetTypeID(v) == CFNumberGetTypeID()) {
    if (!CFNumberGetValue((CFNumberRef)v, kCFNumberDoubleType, &out)) out = fallback;
  }
  return out;
}

int main(void) {
  CFArrayRef wins = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  long n = wins ? CFArrayGetCount(wins) : 0;
  printf("[");
  int first = 1;
  for (long i = 0; i < n; i++) {
    CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(wins, i);
    if (!w || CFGetTypeID(w) != CFDictionaryGetTypeID()) continue;

    CFTypeRef idRef = CFDictionaryGetValue(w, kCGWindowNumber);
    if (!idRef || CFGetTypeID(idRef) != CFNumberGetTypeID()) continue;
    int wid = 0;
    if (!CFNumberGetValue((CFNumberRef)idRef, kCFNumberIntType, &wid)) continue;

    /* 窗口矩形：CGWindowBounds 就是一个表示 CGRect 的字典，交给它自己解 */
    CGRect rect;
    CFTypeRef boundsRef = CFDictionaryGetValue(w, kCGWindowBounds);
    if (!boundsRef || CFGetTypeID(boundsRef) != CFDictionaryGetTypeID()) continue;
    if (!CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)boundsRef, &rect)) continue;
    if (rect.size.width < 8 || rect.size.height < 8) continue;

    double layer = numOr(w, kCGWindowLayer, 0);
    double alpha = numOr(w, kCGWindowAlpha, 1);

    char owner[256];
    CFTypeRef ownerRef = CFDictionaryGetValue(w, kCGWindowOwnerName);
    if (ownerRef && CFGetTypeID(ownerRef) == CFStringGetTypeID()) {
      CFStringGetCString((CFStringRef)ownerRef, owner, sizeof(owner), kCFStringEncodingUTF8);
    } else {
      owner[0] = '\0';
    }
    char safe[512];
    jsonEscape(owner, safe, sizeof(safe));

    if (!first) printf(",");
    first = 0;
    printf("{\"id\":%d,\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f,\"layer\":%d,\"alpha\":%.2f,\"owner\":\"%s\"}",
           wid, rect.origin.x, rect.origin.y, rect.size.width, rect.size.height,
           (int)layer, alpha, safe);
  }
  printf("]\n");
  if (wins) CFRelease(wins);
  return 0;
}
