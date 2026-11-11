# Uygulama kabul kapıları

Bu kayıt uygulama çalışmalarıyla güncellenir. Tasarım, çalışan entegrasyon değildir.

| Katman | Gereken kanıt |
|---|---|
| Yerel istemci → FHE evaluator → yerel sonuç | Gerçek HTTP isteği, yeni client anahtarı, ciphertext evaluator, bağımsız açık referans eşleşmesi |
| Tarayıcı | Ana sayfa → uygulama → geçerli iş → ilerleme → doğru çıktı; hata ve dar ekran kontrolü |
| Yerel servis güvenliği | Host/Origin/CSRF kontrolleri, yol geçişi, girdi sınırları, tek evaluator, kuyruk sınırı, plaintext/SK diske yazılmaması |
| NEAR | Derlenmiş Wasm, yetki/deadline/replay/bağlama testleri; zincir bağlantısı ayrı kanıt ister |
| MPC | Gerçek malicious protokol yürütmesi; sadece compiler veya açık referans yeterli değil; girdi/çıktı bağlama ve bağımsız operatör koşulları ayrı |
| Ödeme | Market izinleri ve gerçek hold/accept mutabakatı doğrulanana kadar kapalı |
| Doğruluk | Yerel referans kontrolü üçüncü tarafa güvenilmeyen ödeme ispatı değildir; attestation/ZK yoksa var denmez |

İlk sürümün sınırı: yerel istemci bilgisayarındaki açık veri ve in-memory anahtarlar o makinenin güven alanındadır. Aynı kullanıcıya ait süreçler güçlü izolasyon sağlamaz. Dış sağlayıcıya teslim edilecek paket yalnız ciphertext/evaluation materyalidir. Dört sayısal kaydın işlenmesi keyfi boyutta CSV veya genel LLM yürütmesi değildir.
