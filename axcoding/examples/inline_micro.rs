use ratatui::{TerminalOptions, Viewport};

fn draw(t: &mut ratatui::DefaultTerminal, status: &str, live: &str) {
    t.draw(|f| {
        use ratatui::style::{Modifier, Style};
        let a = f.area();
        let [l, s, i] = ratatui::layout::Layout::vertical([
            ratatui::layout::Constraint::Length(1),
            ratatui::layout::Constraint::Length(1),
            ratatui::layout::Constraint::Length(1),
        ])
        .areas(a);
        f.render_widget(ratatui::text::Line::from(live.to_string()), l);
        f.render_widget(
            ratatui::text::Line::from(status).style(Style::default().add_modifier(Modifier::DIM)),
            s,
        );
        f.render_widget(ratatui::text::Line::from(format!("> ")), i);
    })
    .unwrap();
}

fn main() {
    let mut t = ratatui::try_init_with_options(TerminalOptions {
        viewport: Viewport::Inline(3),
    })
    .unwrap();
    draw(&mut t, "STATUS-A | the quick brown fox", "");
    std::thread::sleep(std::time::Duration::from_millis(300));
    draw(&mut t, "⠼ working... Ctrl-C cancels this task", "我是一个中文的流式回复正在逐字到达");
    std::thread::sleep(std::time::Duration::from_millis(300));
    // MITIGATION: blank the live row BEFORE the insert scroll.
    draw(&mut t, "⠼ working... Ctrl-C cancels this task", "");
    std::thread::sleep(std::time::Duration::from_millis(120));
    t.insert_before(2, |buf| {
        buf.set_string(0, 0, "我是一个中文的流式回复正在逐字到达", ratatui::style::Style::default());
        buf.set_string(0, 1, "第二行中文内容", ratatui::style::Style::default());
    })
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    draw(&mut t, "STATUS-A | the quick brown fox", "");
    std::thread::sleep(std::time::Duration::from_millis(300));
    ratatui::restore();
    println!("done");
}
