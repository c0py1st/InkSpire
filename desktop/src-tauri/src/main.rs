#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 固定本机端口：与 server 的 Host 守卫同参数（127.0.0.1:PORT），
/// 若被占用（如残留实例）则服务起不来，走错误弹窗提示。
const PORT: u16 = 47821;

static SERVER: Mutex<Option<Child>> = Mutex::new(None);

// 零依赖错误提示：直接 FFI user32.MessageBoxW（不为一个弹窗引 windows crate）
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
}

fn utf1z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn show_error(msg: &str) {
    let (t, c) = (utf1z(msg), utf1z("墨阁启动失败"));
    // MB_ICONERROR = 0x10
    unsafe { MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), 0x10) };
}

/// Windows 下 tauri 的 resource_dir/app_data_dir 可能带 `\\?\` 扩展长度前缀：
/// 文件 API 认它，但 node 的模块解析会把 `\\?\D:` 的盘段落成非法 lstat（实测炸）。
/// 统一剥前缀还原普通路径。
fn plain(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

fn start_server(resource_dir: &Path, data_dir: &Path, log_dir: &Path) -> Result<Child, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let log_path = log_dir.join("server.log");
    // 启动诊断先落日志：出问题时不必Attach调试器
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).and_then(|mut f| {
        use std::io::Write;
        writeln!(f, "[desktop] resource_dir={} data_dir={}", resource_dir.display(), data_dir.display())
    });
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("日志文件打开失败：{e}"))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    Command::new(resource_dir.join("node.exe"))
        .arg(resource_dir.join("server.mjs"))
        .current_dir(resource_dir)
        .env("MOGE_DATA_DIR", data_dir)
        .env("MOGE_PORT", PORT.to_string())
        .env("MOGE_WEB_DIST", resource_dir.join("web-dist"))
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("启动本地服务失败（node.exe）：{e}"))
}

fn wait_until_up(secs: u64) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(secs) {
        if TcpStream::connect(("127.0.0.1", PORT)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// 把 node 子进程挂进 KILL_ON_JOB_CLOSE 的 Job Object：
/// 本进程句柄表由 OS 回收（含 taskkill/崩溃等暴力退出路径）→ Job 最后一个句柄关闭 → 组内进程全灭。
/// 正常关窗另有 RunEvent::Exit 主动 kill 兜底，双保险不留孤儿。
fn attach_kill_on_close(child: &Child) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;

    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE_CLASS: i32 = 9; // JobObjectExtendedLimitInformation

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read: u64,
        write: u64,
        other: u64,
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> *mut core::ffi::c_void;
        fn SetInformationJobObject(job: *mut core::ffi::c_void, class: i32, info: *const core::ffi::c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut core::ffi::c_void, proc: *mut core::ffi::c_void) -> i32;
    }

    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return Err("CreateJobObjectW 失败".to_string());
        }
        let mut info = ExtendedLimit::default();
        info.basic.limit_flags = KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE_CLASS,
            &info as *const _ as *const _,
            std::mem::size_of::<ExtendedLimit>() as u32,
        ) == 0
        {
            return Err("SetInformationJobObject 失败".to_string());
        }
        if AssignProcessToJobObject(job, child.as_raw_handle() as *mut _) == 0 {
            return Err("AssignProcessToJobObject 失败".to_string());
        }
        // 故意永不主动 CloseHandle：进程无论如何终结，OS 收回句柄表即触发连带击杀
        std::mem::forget(job);
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = plain(&app.path().resource_dir().map_err(|e| e.to_string())?);
            // 数据目录三级策略：MOGE_HOME 环境变量 > exe 旁已存在 data/（便携模式自动识别）
            // > 系统应用数据目录（常规安装）
            let (data_dir, log_dir) = match std::env::var("MOGE_HOME") {
                Ok(home) if !home.trim().is_empty() => {
                    let root = plain(std::path::Path::new(home.trim()));
                    (root.join("data"), root)
                }
                _ => {
                    let side_data = resource_dir.join("data");
                    if side_data.is_dir() {
                        (side_data, resource_dir.clone())
                    } else {
                        let appdata = plain(&app.path().app_data_dir().map_err(|e| e.to_string())?);
                        (appdata.join("data"), appdata)
                    }
                }
            };
            let child = match start_server(&resource_dir, &data_dir, &log_dir) {
                Ok(c) => c,
                Err(e) => {
                    show_error(&e);
                    std::process::exit(1);
                }
            };
            // 先挂 Job 再收 handle：此后本进程无论怎么死，node 都跟着走
            if let Err(e) = attach_kill_on_close(&child) {
                eprintln!("[desktop] 防孤儿 Job 挂载失败（正常关窗仍有兜底）：{e}");
            }
            if let Ok(mut g) = SERVER.lock() {
                *g = Some(child);
            }
            if !wait_until_up(30) {
                show_error(
                    "本地服务 30 秒内未就绪。\n可能原因：端口被占用（已有另一个墨阁在跑）。\n详情见数据目录下的 server.log。",
                );
                std::process::exit(1);
            }
            // 窗口在确认服务就绪后才创建：不存在"先开窗口后起服务"的加载竞态
            WebviewWindowBuilder::new(
                &mut *app,
                "main",
                WebviewUrl::External(format!("http://127.0.0.1:{PORT}/").parse().expect("valid url")),
            )
            .title("墨阁 · 小说创作工作台")
            .inner_size(1320.0, 840.0)
            .min_inner_size(1000.0, 620.0)
            .center()
            .resizable(true)
            .build()
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建墨阁应用失败")
        .run(|_app, event| {
            // 退出时带走 node 子进程，不留孤儿
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut g) = SERVER.lock() {
                    if let Some(mut c) = g.take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                }
            }
        });
}
