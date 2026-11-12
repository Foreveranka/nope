# NOPE — uygulama ve testnet doğrulama raporu

12 Kasım 2026. Bu rapor tamamlanan kontrolleri ve kalan ürün sınırlarını ayırır.
Yerel node taşıma katmanının son denetimi tamamlandı; aşağıdaki sınırlar halen geçerlidir.

## Kullanılabilen yüzeyler

- [Tanıtım](https://veil-procurement.vercel.app/): projeyi anlatır; uygulamaya ayrı giriş sunar.
- [İş pazarı](https://veil-procurement.vercel.app/market): süreli müşteri/sağlayıcı davetiyle giriş, üç sağlayıcılı iş taslağı, yayınlama, gizli teklif taahhüdü ve kapanış. Taslak yalnız müşterisine görünür. Bu kimlik sistemi cüzdan imzası değildir.
- [Şifreli hesaplama](https://veil-procurement.vercel.app/app): yerel Python istemcisi kurulumu; dört sayısal kayıt için gerçek uzaktan FHE hesabı. Ham veri ve çözme anahtarı yerel süreç belleğindedir. Bu, herhangi bir CSV'yi işleyen genel hizmet değildir.
- [Testnet kanıtları](https://veil-procurement.vercel.app/testnet): tamamlanmış iş #3'ün gerçek işlem bağlantıları. Sayfa yeni iş/ödeme başlatmaz.

## Ne inşa edildi?

İş kayıtları, teklif kabulü, kapanış, operatör seçimi doğrulaması, sürümlü teslim
ve müşteri kabulü bizim API'mizdir. Vercel özel Blob kayıtları kalıcı tutar;
değiştirilemeyen revizyonlar ve aynı istek anahtarı, kaybolan yanıt sonrası
çift işlemi önler. Fiyat, bütçe ve rastgele açılım bu API'ye gönderilmez.

Müşteri ve sağlayıcı yerel istemcileri, gerçek işe bağlı taahhüt üretir. Açılımlar
bellekte kalır; istemci kapanınca kurtarılabilir anahtar saklama hizmeti yoktur.
Operatör planı/yetkili taşıma bağlantısı yokken gizli girdiyi göndermek reddedilir.

İstemci iş pazarı için `.venv/bin/python scripts/client-launch.py --market`
ile açılır; rol daveti yerel sayfaya girilir. Hesaplama daveti ayrı bir yetkidir.
Sadece yapılandırılmış müşteri sahibi bilgisayarında açılan zincir kayıt düğmesi,
yerel FHE hazırlığıyla sunucudaki işin birebir eşleşmesini kontrol eder.
Cüzdan anahtarı yerelde kalır. Sonucu belirsiz işlem yeniden imzalanmaz.

Bu köprü gerçek bulut uygulamasıyla sınandı: uygulama işi
`8450ea6d48f72c0084daf51f28176d96`, NEAR testnet işi **4** olarak FINAL oldu.
İşlem: `2uKzkWVox48MnS2JAvTiAkGKhvGJPGNERcZhUa7Ugnmk`.
Bu ikinci test yalnız kayıt bağlantısını doğrular; iş #4 için seçim veya ödeme
yapılmadı. Kanıt: `verification/procurement-app-chain-live.json`.
15 köprü, 10 yerel yetki/bağlama ve 14 HTTP testi geçti.

Üç operatörün imzalı seçimini doğrulayan bileşen; kimlik, sertifika, plan, süre,
revizyon, teklif kümesi ve tekrar kontrolleriyle hazırlandı. İmzalar hesaplamanın
matematiksel ispatı değildir. Aynı kişinin üç süreci yönetmesi bağımsızlık sağlamaz.

## Node çalıştırma sonucu

Tek operatör başlatıcısı ve açıkça etkinleştirilen TLS ağ taşıması tamamlandı.
42 test (8 derleme kaynağı denetimi, 10 başlatıcı testi dahil) geçti. Son gerçek
üç taraflı sentetik MPC koşumu 7,85 saniyede tamamlandı; tekrar reddi, geçici
anahtar temizliği, varsayılan yerel çalışma ve beş TLS regresyonu doğrulandı.
Derlemeye gizlice eklenen staged değişiklikleri atlayabilen kontrol düzeltildi.

Bu Mac üzerinde yalnız 127.0.0.1 ve farklı portlar kullanıldı. Diğer iki yerel
arayüz bağlanamadığından üç arayüz testi yapılmış sayılmadı. WAN, ayrı sunucu
ve bağımsız yönetici doğrulaması yoktur. Kurulum: `../operators/deploy/NATIVE-LAUNCH.md`;
kanıt: `../mpc/evidence/explicit-bind-final-verification.json`.

## Gerçek testnet sonucu

`veil-reg-e138f5c88250f821.testnet` üzerinde iş **3**:

1. Gerçek FHE girdisi hazırlanıp işe bağlandı.
2. Üç ayrı testnet sağlayıcısının taahhüdü kaydedildi; gerçek süre beklendi.
3. Gerçek yerel üç taraflı MPC çalıştı; p2 seçildi.
4. Şifreli hesap yapıldı; müşteri yerelde çözüp referansla karşılaştırdı.
5. Sonuç makbuzu kaydedildi, müşteri o teslimi kabul etti.
6. Ayrı testnet escrow p2'ye **0,001 test NEAR** aktardı.

İlk sekiz işlem FINAL, 16 bağlama/sonuç kontrolü başarılı. Çekirdek koşum
266,46 saniye; bunun içinde gerçek teklif süresi beklenmesi var.
Ana ajan son zincir kaydını ve şifreli çıktı hash'ini bağımsız kontrol etti.
Ödeme için gerçek native Transfer makbuzu, tutar, alıcı ve kabul edilen iş
bağları ayrıca doğrulandı. Yeniden açılan süreç aynı hash'i sorguladı;
yeni yayın veya ikinci ödeme olmadı.

Ödeme gizli MPC fiyatıyla eşitliği kanıtlanan tutar değildir: herkese açık,
sabit test bedelidir. Gerçek para veya mainnet kullanılmadı.

Kanıtlar: `verification/e2e-testnet-result.json`,
`verification/testnet-main-crosscheck.json`,
`verification/testnet-payment-main-crosscheck.json`,
`../payments/testnet_escrow/verification/testnet-completion.json`.

## Dış bağımlılıklar nasıl ele alındı?

| İhtiyaç | Kullanılan çözüm | Doğrulanan sınır |
|---|---|---|
| Kalıcı uygulama kayıtları | Mevcut Vercel özel Blob | Gerçek HTTPS üzerinden kalıcılık, rol erişimi ve tekrar denetimi |
| Şifreli hesap sunucusu | Mevcut Vercel Linux evaluator | Önceki iki gerçek bulut FHE koşumu; iş #3'ün FHE hesabı yereldir |
| NEAR RPC | Resmî NEAR listesindeki ücretsiz FastNear testnet RPC | Önceki uçtaki 429 sonrası gerçek final zincir işlemleri; imzalı işlem kör tekrar edilmez |
| Testnet ödeme | Kendi NEAR escrow sözleşmemiz | Gerçek dağıtım, kabul bağına göre ödeme ve Transfer makbuzu |
| NEAR Agent Market | Resmî API/araç adaptörleri ve sınır incelemesi | Kullanılabilir sandbox doğrulanmadı; üretim USDC'si test diye kullanılmadı |
| Bağımsız MPC sunucuları | Node kimliği, plan, TLS ve çalıştırma yazılımı | Üç bağımsız yönetici/kalıcı sunucu sağlanmış değildir |

NEAR RPC kaynağı: https://docs.near.org/api/rpc/providers . Market sınırları:
`../payments/LIVE-GAPS.md`. Yeni ücretli hizmet açılmadı.

## ZeroFi'den ne alındı?

Mimari inceleme yapıldı; bütün kaynak kodun güvenlik denetimi yapıldığı iddia
edilmiyor. Node kimliği, sabit üyelik kümesi, kimliği doğrulanmış bağlantı,
dayanıklı işlem günlüğü ve imzalı makbuz yaklaşımı NOPE'ye uygundur.
Monero köprü binary'sini çalıştırmak gizli ihaleyi veya FHE doğruluğunu sağlamaz.
Eşik imzası ile hesaplama ispatı ayrı tutuldu. Ayrıntı:
`NOPE-DEPENDENCIES-AND-ZEROFI.md`, `../operators/ZEROFI-ARCHITECTURE.md`.

## Eksiksiz müşteri ürünü dememizi engelleyenler

- Davetli ekran akışının tamamı henüz zincir kaydı, özel MPC girdi oturumu,
  seçilen sağlayıcı yürütmesi ve escrow ödemesine otomatik bağlanmış değildir.
- Ayrı yönetim altında üç gerçek sürekli node yoktur. Vercel HTTP API veya
  aynı hesaptaki üç süreç bu güven varsayımının yerine geçmez.
- Gizli kazanan fiyatla herkese açık ödeme arasında kriptografik eşitlik ispatı yoktur.
- Mevcut registry tek müşteri sahibine bağlı testnet pilotudur; çok müşterili
  cüzdan yetkilendirmesi ve ticari anahtar/uyuşmazlık işletimi tamamlanmış değildir.
- Genel veri işleme, bağımsız yürütme ispatı, WAN kapasite/abort dayanıklılığı ve
  ticari üretim güvenliği doğrulanmış değildir.

Bu sınırlar kaynak kodda ve arayüz yeteneklerinde kapalı tutulur; tamamlanmış
testnet işlemi bitmiş genel amaçlı pazar yeri diye sunulmaz.
