# İlk sürümün güven sınırları

## Korunan varlıklar

- Dört sayısal kaydın açık içeriği ve FHE secret key: şirketin yerel istemci sürecinde.
- Şifreli iş paketi: evaluator'a verilebilir; kimlik/başlık, kayıt sayısı ve devre profili gibi metadatayı tümüyle gizlemez.
- Gizli teklif/bütçe: ayrı MPC protokolünün varlıkları. FHE dosya işinin anahtar modeli bunların yerine geçmez.
- On-chain kayıt: yalnız açık bağlam, commitment/hash ve durumlar. Dosya içeriği, secret key, teklif/bütçe açık değerleri yazılmaz.

## Saldırganlar ve kabul kararı

| Saldırgan | İlk sürümde kontrol | Açık sınır |
|---|---|---|
| Ziyaret edilen kötü web sitesi | Exact Host/Origin, CSRF nonce, same-origin CSP, loopback bind, API no-store | Tarayıcı/işletim sistemi ele geçirilmesini çözmez |
| Dosya/yol girdisi | Sabit şema, tamsayı/range/count sınırı, statik dosya allowlist, sunucu iş kimliği | Genel müşteri CSV türleri desteklenmez |
| Kötü hesaplama çıktısı | Kendi işine bağlı sonuç, hash eşleşmesi ve yerel açık referans karşılaştırması | Referansı yeniden hesaplamak outsource ekonomisini veya satıcıya adil ödemeyi ispatlamaz |
| Kötü FHE artifact'i | Derleme artifact'i yerel sabit allowlist/hash; kullanıcı devre yükleyemez | Aynı OS kullanıcısı programı değiştirebilir; host kompromisi çözülmez |
| Kötü koordinatör | Sabit roster/bidset ve context binding, kontrat yetki/durum testleri | Kontratın çalışması MPC girdilerinin doğru eşleştiğini kendiliğinden ispatlamaz |
| MPC operatör işbirliği | Seçilen malicious protokol ve açık bozulma eşiği | Aynı Mac'teki üç süreç üç bağımsız operatör değildir; durdurma/adil çıktı teslimi ayrı konudur |
| İşi ödemeden alan müşteri | Bu sürümde gerçek ödeme devre dışı | Hold ve tarafsız kabul/uyuşmazlık akışı entegre edilmeden adil ödeme vaat edilmez |

## İncelemede zorunlu ayrımlar

`hash doğru` → `işlem doğru` değildir. `yerel referans doğru` → `attestation/ZK` değildir. `kontrat testleri geçti` → `testnet deploy edildi` değildir. `MPC devresi derlendi` → `malicious protokol çalıştı` değildir. `üç yerel party çalıştı` → `operatörler bağımsız` değildir.

İstemci sonucu gösterir; evaluator'a açık sonuç, ayrıntılı decrypt hata bilgisi veya key göndermez. Rastgele ciphertext'ler için herkese açık decrypt API açılmaz. Bununla birlikte seçilen FHE şemasının kötü niyetli ciphertext/çıktı paylaşma güvenliği uzman incelemesi gerektirir; bu prototip bağımsız kriptografik denetim değildir.
