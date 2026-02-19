// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if gcalendarwin_lib::run_oauth_helper_if_requested() {
        return;
    }
    gcalendarwin_lib::run()
}
