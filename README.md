# Veil Procurement

NEAR üzerinde gizli tekliflerle iş satın alma ve müşteri verisini açık hâliyle yürütücüye vermeden hesaplatma projesinin uygulaması.

İlk yerel uygulama dört sayısal kaydı gerçek Concrete FHE ile işler. Kayıt kimliklerinin tekrarlarını işaretler, eksik değer kodunu sıfıra çevirir ve 100 üstü değerleri sınırlar. Python istemci açık veriyi ve secret key'i kendi belleğinde tutar; ayrı evaluator şifreli isteği işler. Bu çalışma **sentetik veri prototipidir**.

## Çalıştırma

```sh
cd /Users/mete/near-private-procurement
./scripts/run-local.sh
```

Ana sayfa: `http://127.0.0.1:8765/`. Uygulama ayrı `/app` yolundadır. Port için `VEIL_PORT`, Concrete kurulu Python için `VEIL_PYTHON` değişkenleri kullanılabilir. Başlatıcı önce proje `.venv` ortamını, yoksa bu bilgisayardaki doğrulanmış araştırma ortamını kullanır. Gerçek anahtar üretimi ve FHE hesabı ilk istekte zaman alır.

Servis loopback dışına açılmaz. Kayıtlar ve açık sonuçlar kalıcı dosyaya yazılmaz; süreç kapanınca iş geçmişi kaybolur. Şifreli çalışma dosyaları Git dışında `runtime/` altındadır. HTTP servisini internete reverse proxy ile açmak desteklenmez.

## Uçtan uca kontrol

Servis açıkken:

```sh
python3 scripts/verify-http.py
```

Bu komut sentetik veriyle gerçek FHE işi başlatır, bağımsız beklenen çıktıyı ve HTTP güven sınırlarını denetler. Çıktı `runtime/http-fhe-check.json` olur. Testler çalıştırılmadan bu README başarı kanıtı değildir; güncel sonuçlar `docs/BUILD-STATUS.md` içindedir.

## Bileşenler

| Yol | Sorumluluk |
|---|---|
| `web/` | Tanıtım sayfası ve yerel çalışma alanı |
| `service/` | Yerel istemci HTTP arayüzü, kuyruk ve API |
| `engine/` | Sabit FHE devresi, istemci/evaluator ayrımı |
| `contracts/registry/` | NEAR iş/teklif commitment kayıtları |
| `mpc/` | Ayrı çok taraflı gizli teklif hesabı |
| `sdk/` | Motor kayıtlarını NEAR receipt şemasına bağlayan, işlem imzalamayan adaptör |
| `scripts/` | Başlatma ve bağımsız entegrasyon kontrolleri |

NEAR kontratı ve MPC bileşeni `/demo` üzerinden gerçek yerel uçtan uca akışta birlikte çalışır. Gerçek Market ödemesi, bağımsız MPC operatörleri ve attestation/ZK doğrulaması ayrı kabul kapılarıdır. Uygulama desteklemediği yetenekleri hazır göstermez. Ayrıntılar: `docs/INTEGRATION-GATES.md` ve `docs/SECURITY-BOUNDARIES.md`.

FHE parametre/artifact kaynakları mevcut araştırmadan korunarak alınmıştır. Üçüncü taraf yazılım lisansları kendi bileşen belgelerinde yer alır; bu depo üçüncü taraf patent veya ticari kullanım lisansı vermez.

Commitment döngüsünü çözen v2 entegrasyonu `integration/README.md` ve `mpc/V2.md` içindedir. Kalan üretim kapıları `docs/NEXT-INTEGRATION.md` içindedir. Yerel uçtan uca akış, tamamlanmış ticari ödeme ürünü değildir.

Hangi verinin kimden ve hangi kriptografik mekanizmayla gizlendiği `docs/PRIVACY.md` içinde; gerçek testlerin kapsamı ve sonuçları `docs/BUILD-STATUS.md` içindedir.

## Tam akış ve web yayını

Yerel serviste `/demo`, sabit sentetik girdilerle gerçek FHE hazırlama → NEAR sandbox kaydı → üç taraflı MPC → seçilen yürütücü → FHE değerlendirme → istemci doğrulama → kontratta kabul akışını başlatır. Ödeme adımları SQLite fixture simülasyonudur; gerçek para kullanılmaz. Terminal karşılığı: `./scripts/run-integration.sh`.

GitHub deposu `Foreveranka/veil-procurement`, Vercel projesi `veil-procurement` ile bağlıdır. `main` dalına push production dağıtımını tetikler. `node scripts/build-web.mjs` yalnız allowlist web dosyalarını ve temizlenmiş **önceden çalıştırılmış yerel test sonucunu** yayımlar. Vercel üzerinde FHE, MPC veya NEAR node çalışmaz; `/app` bunu açıklar, `/demo` kayıtlı kanıtı gösterir. Yerel API internete açılmaz. Ayrıntı: `docs/DEPLOYMENT.md`.
