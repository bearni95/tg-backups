#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tgb_backend::serve().await
}
