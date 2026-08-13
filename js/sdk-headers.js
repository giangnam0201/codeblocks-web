/* ---------------------------------------------------------------------------
   sdk-headers.js - extra headers installed into the compiler's sysroot.

   The toolchain targets wasm32-wasi with libc++, so it has the whole C++
   standard library but none of the Windows SDK.  A great deal of teaching and
   contest code on Windows includes <windows.h> or <conio.h> for a handful of
   things - Sleep, colours, clearing the screen, getch - and all of those can
   be provided honestly on this target:

     * console colours, cursor movement and clearing map onto the ANSI escape
       sequences that the program console understands;
     * Sleep and GetTickCount use the real clock;
     * getch/kbhit read stdin, which the console feeds interactively.

   What genuinely cannot work is the network: WASI has no sockets, and a web
   page cannot open raw TCP.  <winsock2.h>, <wininet.h> and <winhttp.h> are
   therefore provided as declarations that compile and fail predictably at
   runtime, and they say so with a #warning at compile time rather than
   pretending to connect.
--------------------------------------------------------------------------- */
'use strict';

const SDK_HEADERS = {};

/* ------------------------------------------------------------- windows.h */

SDK_HEADERS['include/windows.h'] = `
#ifndef CBWEB_WINDOWS_H
#define CBWEB_WINDOWS_H
/* Windows compatibility layer for the Code::Blocks web edition (wasm32-wasi). */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned char      BYTE;
typedef unsigned short     WORD;
typedef unsigned long      DWORD;
typedef int                BOOL;
typedef int                INT;
typedef unsigned int       UINT;
typedef long               LONG;
typedef unsigned long      ULONG;
typedef long long          LONGLONG;
typedef unsigned long long ULONGLONG;
typedef char               CHAR;
typedef wchar_t            WCHAR;
typedef const char*        LPCSTR;
typedef char*              LPSTR;
typedef const wchar_t*     LPCWSTR;
typedef wchar_t*           LPWSTR;
typedef void*              LPVOID;
typedef void*              HANDLE;
typedef void*              HWND;
typedef void*              HINSTANCE;
typedef void*              HMODULE;
typedef unsigned long*     LPDWORD;
typedef long               HRESULT;
typedef LPCSTR             LPCTSTR;
typedef LPSTR              LPTSTR;
typedef unsigned int       SIZE_T;

#define WINAPI
#define APIENTRY
#define CALLBACK
#define TRUE  1
#define FALSE 0
#ifndef NULL
#define NULL 0
#endif
#define MAX_PATH 260
#define INVALID_HANDLE_VALUE ((HANDLE)-1)
#define STD_INPUT_HANDLE  ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define STD_ERROR_HANDLE  ((DWORD)-12)
#define INFINITE 0xFFFFFFFF

/* console text attributes, as in wincon.h */
#define FOREGROUND_BLUE      0x0001
#define FOREGROUND_GREEN     0x0002
#define FOREGROUND_RED       0x0004
#define FOREGROUND_INTENSITY 0x0008
#define BACKGROUND_BLUE      0x0010
#define BACKGROUND_GREEN     0x0020
#define BACKGROUND_RED       0x0040
#define BACKGROUND_INTENSITY 0x0080

/* message box flags (accepted, then printed to the console) */
#define MB_OK               0x0000
#define MB_OKCANCEL         0x0001
#define MB_YESNO            0x0004
#define MB_ICONERROR        0x0010
#define MB_ICONQUESTION     0x0020
#define MB_ICONWARNING      0x0030
#define MB_ICONINFORMATION  0x0040
#define IDOK     1
#define IDCANCEL 2
#define IDYES    6
#define IDNO     7

typedef struct _COORD { short X; short Y; } COORD;
typedef struct _SMALL_RECT { short Left, Top, Right, Bottom; } SMALL_RECT;
typedef struct _CONSOLE_SCREEN_BUFFER_INFO {
    COORD dwSize, dwCursorPosition;
    WORD  wAttributes;
    SMALL_RECT srWindow;
    COORD dwMaximumWindowSize;
} CONSOLE_SCREEN_BUFFER_INFO;
typedef struct _SYSTEMTIME {
    WORD wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds;
} SYSTEMTIME;

/* --- timing ------------------------------------------------------------- */

static __inline void Sleep(DWORD ms) {
    clock_t start = clock();
    clock_t want  = (clock_t)((double)ms * (double)CLOCKS_PER_SEC / 1000.0);
    while ((clock() - start) < want) { /* busy wait: this target has no timers */ }
}
static __inline DWORD GetTickCount(void) {
    return (DWORD)((double)clock() * 1000.0 / (double)CLOCKS_PER_SEC);
}
static __inline ULONGLONG GetTickCount64(void) {
    return (ULONGLONG)((double)clock() * 1000.0 / (double)CLOCKS_PER_SEC);
}
static __inline void GetLocalTime(SYSTEMTIME* st) {
    time_t t = time(0);
    struct tm* lt = localtime(&t);
    if (!st || !lt) return;
    st->wYear = (WORD)(lt->tm_year + 1900); st->wMonth = (WORD)(lt->tm_mon + 1);
    st->wDay = (WORD)lt->tm_mday;           st->wDayOfWeek = (WORD)lt->tm_wday;
    st->wHour = (WORD)lt->tm_hour;          st->wMinute = (WORD)lt->tm_min;
    st->wSecond = (WORD)lt->tm_sec;         st->wMilliseconds = 0;
}
#define GetSystemTime GetLocalTime

/* --- console ------------------------------------------------------------ */
/* The console understands ANSI escapes, so the wincon calls map onto them. */

static __inline HANDLE GetStdHandle(DWORD which) { (void)which; return (HANDLE)1; }

static __inline BOOL SetConsoleTextAttribute(HANDLE h, WORD attr) {
    static const int fg[8] = { 30, 34, 32, 36, 31, 35, 33, 37 };
    (void)h;
    printf("\\033[0m");
    if (attr & FOREGROUND_INTENSITY) printf("\\033[1m");
    printf("\\033[%dm", fg[attr & 7]);
    printf("\\033[%dm", 40 + ((attr >> 4) & 7));
    fflush(stdout);
    return TRUE;
}
static __inline BOOL SetConsoleCursorPosition(HANDLE h, COORD c) {
    (void)h;
    printf("\\033[%d;%dH", c.Y + 1, c.X + 1);
    fflush(stdout);
    return TRUE;
}
static __inline BOOL SetConsoleTitleA(LPCSTR title) {
    printf("\\033]0;%s\\007", title ? title : "");
    fflush(stdout);
    return TRUE;
}
#define SetConsoleTitle SetConsoleTitleA
static __inline BOOL GetConsoleScreenBufferInfo(HANDLE h, CONSOLE_SCREEN_BUFFER_INFO* i) {
    (void)h;
    if (!i) return FALSE;
    i->dwSize.X = 80; i->dwSize.Y = 25;
    i->dwCursorPosition.X = 0; i->dwCursorPosition.Y = 0;
    i->wAttributes = 7;
    i->srWindow.Left = 0; i->srWindow.Top = 0;
    i->srWindow.Right = 79; i->srWindow.Bottom = 24;
    i->dwMaximumWindowSize = i->dwSize;
    return TRUE;
}
static __inline int MessageBoxA(HWND w, LPCSTR text, LPCSTR caption, UINT type) {
    (void)w;
    printf("\\n[%s] %s\\n", caption ? caption : "Message", text ? text : "");
    fflush(stdout);
    return (type & MB_YESNO) ? IDYES : IDOK;
}
#define MessageBox MessageBoxA

/* --- misc --------------------------------------------------------------- */

static __inline DWORD GetLastError(void) { return 0; }
static __inline void  SetLastError(DWORD e) { (void)e; }
static __inline BOOL  Beep(DWORD f, DWORD d) { (void)f; (void)d; printf("\\a"); return TRUE; }
static __inline void  ExitProcess(UINT code) { exit((int)code); }
static __inline HMODULE GetModuleHandleA(LPCSTR n) { (void)n; return (HMODULE)0; }
#define GetModuleHandle GetModuleHandleA
static __inline DWORD GetCurrentProcessId(void) { return 1; }
static __inline DWORD GetCurrentThreadId(void) { return 1; }
static __inline short GetAsyncKeyState(int key) { (void)key; return 0; }

#ifdef __cplusplus
}
#endif
#endif /* CBWEB_WINDOWS_H */
`;

/* --------------------------------------------------------------- conio.h */

SDK_HEADERS['include/conio.h'] = `
#ifndef CBWEB_CONIO_H
#define CBWEB_CONIO_H
/* Turbo C / Windows console helpers, on top of stdin and ANSI escapes. */

#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BLACK 0
#define BLUE 1
#define GREEN 2
#define CYAN 3
#define RED 4
#define MAGENTA 5
#define BROWN 6
#define LIGHTGRAY 7
#define DARKGRAY 8
#define LIGHTBLUE 9
#define LIGHTGREEN 10
#define LIGHTCYAN 11
#define LIGHTRED 12
#define LIGHTMAGENTA 13
#define YELLOW 14
#define WHITE 15

/* Reads one character.  The console supplies input a line at a time, so the
   first call after a prompt waits for the user exactly as a terminal does. */
static __inline int getch(void)  { return getchar(); }
static __inline int getche(void) { int c = getchar(); if (c != EOF) putchar(c); return c; }
static __inline int putch(int c) { return putchar(c); }

/* Peeking without consuming is not possible on this stdin, so kbhit waits for
   a character and pushes it back. */
static __inline int kbhit(void) {
    int c = getchar();
    if (c == EOF) return 0;
    ungetc(c, stdin);
    return 1;
}

static __inline void clrscr(void)            { printf("\\033[2J\\033[H"); fflush(stdout); }
static __inline void gotoxy(int x, int y)    { printf("\\033[%d;%dH", y, x); fflush(stdout); }
static __inline void textcolor(int c) {
    static const int fg[8] = { 30, 34, 32, 36, 31, 35, 33, 37 };
    printf("\\033[0m");
    if (c & 8) printf("\\033[1m");
    printf("\\033[%dm", fg[c & 7]);
    fflush(stdout);
}
static __inline void textbackground(int c) {
    static const int bg[8] = { 40, 44, 42, 46, 41, 45, 43, 47 };
    printf("\\033[%dm", bg[c & 7]);
    fflush(stdout);
}
static __inline void wherexy(int* x, int* y) { if (x) *x = 1; if (y) *y = 1; }

#ifdef __cplusplus
}
#endif
#endif /* CBWEB_CONIO_H */
`;

/* ------------------------------------------------------------ networking */

/* Sockets cannot work here.  These headers exist so that code using them still
   compiles; every call fails with a clear error instead of misbehaving. */
const NET_WARNING = header => `
#ifndef CBWEB_${header.toUpperCase().replace(/[^A-Z0-9]/g, '_')}
#define CBWEB_${header.toUpperCase().replace(/[^A-Z0-9]/g, '_')}
#warning "${header}: this target (WebAssembly/WASI in a browser) has no sockets - network calls compile but fail at runtime"
`;

SDK_HEADERS['include/winsock2.h'] = NET_WARNING('winsock2.h') + `
#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned int   SOCKET;
typedef unsigned short u_short;
typedef unsigned long  u_long;
typedef unsigned int   u_int;

#define INVALID_SOCKET (SOCKET)(~0)
#define SOCKET_ERROR   (-1)
#define AF_INET        2
#define SOCK_STREAM    1
#define SOCK_DGRAM     2
#define IPPROTO_TCP    6
#define WSAENETDOWN    10050
#define WSAVERNOTSUPPORTED 10092
#define MAKEWORD(a, b) ((WORD)(((BYTE)(a)) | (((WORD)((BYTE)(b))) << 8)))

struct in_addr { unsigned long s_addr; };
struct sockaddr { unsigned short sa_family; char sa_data[14]; };
struct sockaddr_in {
    short sin_family; unsigned short sin_port;
    struct in_addr sin_addr; char sin_zero[8];
};
typedef struct WSAData {
    WORD wVersion, wHighVersion;
    char szDescription[257], szSystemStatus[129];
    unsigned short iMaxSockets, iMaxUdpDg;
    char* lpVendorInfo;
} WSADATA, *LPWSADATA;

static __inline int    WSAGetLastError(void) { return WSAENETDOWN; }
static __inline int    WSAStartup(WORD v, LPWSADATA d) {
    (void)v;
    if (d) { d->wVersion = 0; d->szDescription[0] = 0; d->szSystemStatus[0] = 0; }
    return WSAVERNOTSUPPORTED;
}
static __inline int    WSACleanup(void) { return 0; }
static __inline SOCKET socket(int a, int t, int p) { (void)a; (void)t; (void)p; return INVALID_SOCKET; }
static __inline int    connect(SOCKET s, const struct sockaddr* n, int l) { (void)s; (void)n; (void)l; return SOCKET_ERROR; }
static __inline int    bind(SOCKET s, const struct sockaddr* n, int l) { (void)s; (void)n; (void)l; return SOCKET_ERROR; }
static __inline int    listen(SOCKET s, int b) { (void)s; (void)b; return SOCKET_ERROR; }
static __inline SOCKET accept(SOCKET s, struct sockaddr* a, int* l) { (void)s; (void)a; (void)l; return INVALID_SOCKET; }
static __inline int    send(SOCKET s, const char* b, int l, int f) { (void)s; (void)b; (void)l; (void)f; return SOCKET_ERROR; }
static __inline int    recv(SOCKET s, char* b, int l, int f) { (void)s; (void)b; (void)l; (void)f; return SOCKET_ERROR; }
static __inline int    closesocket(SOCKET s) { (void)s; return 0; }
static __inline u_short htons(u_short v) { return (u_short)((v << 8) | (v >> 8)); }
static __inline u_long  htonl(u_long v) {
    return ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >> 8) & 0xFF00) | ((v >> 24) & 0xFF);
}
#define ntohs htons
#define ntohl htonl
static __inline unsigned long inet_addr(const char* s) { (void)s; return 0xFFFFFFFF; }

#ifdef __cplusplus
}
#endif
#endif
`;

SDK_HEADERS['include/ws2tcpip.h'] = NET_WARNING('ws2tcpip.h') + `
#include <winsock2.h>
#ifdef __cplusplus
extern "C" {
#endif
struct addrinfo {
    int ai_flags, ai_family, ai_socktype, ai_protocol;
    unsigned int ai_addrlen;
    char* ai_canonname;
    struct sockaddr* ai_addr;
    struct addrinfo* ai_next;
};
static __inline int getaddrinfo(const char* n, const char* s,
                                const struct addrinfo* h, struct addrinfo** r) {
    (void)n; (void)s; (void)h; if (r) *r = 0; return WSAENETDOWN;
}
static __inline void freeaddrinfo(struct addrinfo* a) { (void)a; }
static __inline const char* inet_ntop(int f, const void* a, char* d, unsigned long l) {
    (void)f; (void)a; if (d && l) d[0] = 0; return d;
}
#ifdef __cplusplus
}
#endif
#endif
`;

SDK_HEADERS['include/wininet.h'] = NET_WARNING('wininet.h') + `
#include <windows.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef void* HINTERNET;
#define INTERNET_OPEN_TYPE_DIRECT 1
#define INTERNET_SERVICE_HTTP 3
static __inline HINTERNET InternetOpenA(LPCSTR a, DWORD t, LPCSTR p, LPCSTR x, DWORD f) {
    (void)a; (void)t; (void)p; (void)x; (void)f; return (HINTERNET)0;
}
static __inline HINTERNET InternetOpenUrlA(HINTERNET h, LPCSTR u, LPCSTR hd,
                                           DWORD hl, DWORD f, DWORD c) {
    (void)h; (void)u; (void)hd; (void)hl; (void)f; (void)c; return (HINTERNET)0;
}
static __inline BOOL InternetReadFile(HINTERNET h, LPVOID b, DWORD n, LPDWORD r) {
    (void)h; (void)b; (void)n; if (r) *r = 0; return FALSE;
}
static __inline BOOL InternetCloseHandle(HINTERNET h) { (void)h; return TRUE; }
#define InternetOpen InternetOpenA
#define InternetOpenUrl InternetOpenUrlA
#ifdef __cplusplus
}
#endif
#endif
`;

SDK_HEADERS['include/winhttp.h'] = NET_WARNING('winhttp.h') + `
#include <windows.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef void* HINTERNET;
#define WINHTTP_ACCESS_TYPE_DEFAULT_PROXY 0
static __inline HINTERNET WinHttpOpen(LPCWSTR a, DWORD t, LPCWSTR p, LPCWSTR x, DWORD f) {
    (void)a; (void)t; (void)p; (void)x; (void)f; return (HINTERNET)0;
}
static __inline HINTERNET WinHttpConnect(HINTERNET s, LPCWSTR n, int port, DWORD r) {
    (void)s; (void)n; (void)port; (void)r; return (HINTERNET)0;
}
static __inline BOOL WinHttpCloseHandle(HINTERNET h) { (void)h; return TRUE; }
#ifdef __cplusplus
}
#endif
#endif
`;

/* A few more headers Windows code reaches for. */
SDK_HEADERS['include/tchar.h'] = `
#ifndef CBWEB_TCHAR_H
#define CBWEB_TCHAR_H
#include <string.h>
typedef char TCHAR;
#define _T(x) x
#define _TEXT(x) x
#define _tprintf printf
#define _tcscpy strcpy
#define _tcslen strlen
#define _tcscmp strcmp
#endif
`;

SDK_HEADERS['include/io.h'] = `
#ifndef CBWEB_IO_H
#define CBWEB_IO_H
#include <unistd.h>
#endif
`;

SDK_HEADERS['include/direct.h'] = `
#ifndef CBWEB_DIRECT_H
#define CBWEB_DIRECT_H
#include <unistd.h>
#include <sys/stat.h>
#define _mkdir(p) mkdir((p), 0777)
#define _rmdir rmdir
#define _chdir chdir
#define _getcwd getcwd
#endif
`;

SDK_HEADERS['include/process.h'] = `
#ifndef CBWEB_PROCESS_H
#define CBWEB_PROCESS_H
#include <stdlib.h>
#define _exit exit
#endif
`;

if (typeof self !== 'undefined') self.SDK_HEADERS = SDK_HEADERS;
