# Bir sonraki entegrasyon: commitment sırası ve gerçek iş yaşam döngüsü

Bu belge ilk tasarımı ve kalan üretim kapılarını korur. **11 Kasım güncellemesi:** aşağıdaki v2 ayrımı, staged FHE ve registry kazanan ataması artık `integration/run.py` içinde gerçek yerel birleşik yürütmeyle uygulanmıştır. Önceki zaman kipleri tarihsel tasarımı anlatır; güncel kanıt `verification/e2e-local-result.json` ve `e2e-artifact-audit.json` içindedir. Bu bir üretim güvenlik ispatı değildir.

Uygulanan sıra: prepare → registry create/bid/close → MPC selection manifest (henüz execution attempt yok) → buyer yetkili selected_executor/v2 attempt → fixture hold → engine external binding → evaluate/finalize → executor report → buyer accept → fixture release. Kalıcı yerel selection admission ve süreç kilidi aynı yerel seçimin tekrarını sınırlar; bağımsız operatör konsensüsü sağlamaz.

## Çözülmesi gereken döngü

MPC v1 commitment'i descriptor hash'ini içerir. Descriptor registry `job_binding_hash` ve `attempt_binding_hash` içerirse, registry job'ının bütçe commitment'ini; attempt'in de teklif commitment'lerinden oluşan bidset root'u içermesi döngü yaratır. Bu hash'lerin sabit noktasını aramak çözüm değildir. Mevcut yerel MPC fixture'ları açıkça sentetik bağlam kullanır.

## V2 için önerilen ayrım

1. Alıcı, commitment'lerden **önce** bir iş niyeti oluşturur: ağ alanı, kontrat hesabı, alıcı hesabı, kriptografik rastgele 32-byte nonce, sabit profil/sürüm, sıralı katılımcı hesapları, her slotun qualification bilgisi, ücret kuralı, deadline'lar ve çıktı politikası. Tamsayılar ve hesaplar tek kanonik binary codec ile kodlanır; domain tag sürümlüdür.
2. `precommit_context = SHA256(canonical(intent))`. Burada bütçe/teklif commitment'i, son bidset root'u, job/attempt binding hash'i bulunmaz. Nonce bir imzalı/kontrat bağlamıyla kullanılır; hash'in tek başına kimlik doğrulamadığı korunur.
3. Her taraf `SHA256(tag || precommit_context || slot || uint64_be(amount) || salt32)` üretir. Salt yalnız o tarafa aittir. MPC içinde aynı amount ve salt ile bu commitment yeniden hesaplanır.
4. Alıcı registry job oluştururken intent hash'ini `context_hash` alanına, bütçe commitment'ini kendi alanına koyar. Registry'nin diğer yapılandırmasının intent ile eşleşmesini adaptör yeniden kodlayarak denetler. `context_hash` alanının varlığı tek başına bu tutarlılığı kontratta ispatlamaz.
5. Yetkili satıcılar aynı precommit context altında teklif verir. Son tarih sonrası **tüm** kabul edilmiş commitment'leri içeren kök dondurulur. Eksik slotun politikası ayrıca tanımlanır; mevcut üç slotlu MPC v1'de eksik giriş timeout/abort demektir.
6. Çalıştırma manifest'i bundan sonra gerçek job/attempt binding hash'lerini, tam roster/bidset'i, precommit context'i, MPC build/profile hash'ini içerir. Client'lar finalize edilmiş registry durumunu ve manifest'i birbirinden bağımsız doğrular; TLS üzerinden tüm operatörlere aynı manifest kimliğini yollar. İşlem içindeki commitment kontrolü precommit context'i kullanır; çalıştırma bağlamı manifest ile ayrı bağlanır.
7. Tekrarlama hakkı registry durumuna bağlıdır. Aynı girdilerle birden çok uyarlanabilir sorgunun bütçe sızdırmasına izin verilmez. Bir yerel process'in `attempt` dizgesini değiştirmesi zincirde izin yaratmaz. Kalıcı attempt kaydı, fork/finality politikası ve operatörlerin kabul kuralı ayrıca uygulanır.

Bu şema mevcut v1'in üzerine sessizce uygulanamaz: commitment codec sürümü, test vektörleri ve program hash'i değişir. Önce bağımsız codec testleri, sonra gerçek MPC, sonra yerel NEAR entegrasyon testleri gerekir.

## FHE işinin kronolojik bağı

Şu an HTTP işi anahtar üretme → şifreleme → hesaplatma → çözme adımlarını tek çağrıda tamamlar. Registry sandbox'ına bu işin hash'lerinin sonradan yazılması, hash formatı uyumunu sınar; önceden taahhüt edilmiş ticaret değildir.

Gerçek akış için motor ayrı `prepare`, `evaluate`, `finalize` adımlarına ayrılmalı: `prepare` şirket tarafında anahtar ve ciphertext üretir; registry input/circuit/key/policy bağları **evaluate'den önce** sabitlenir; yalnız seçilmiş sağlayıcı ciphertext/evaluation materyalini alır; `finalize` yalnız beklenen job/attempt bağlamına ait çıktı için yerelde decrypt yapar. Secret key yalnız şirket istemcisinde kalır. Süreç kapanırsa devam edip edememe politikası ayrıca tasarlanmalıdır; sessizce anahtar dosyasına dönüştürülmez.

## Ticari kabulün açık kapıları

- İlk başarılı MPC fixture'ında party 0 log'u toplam **1.758,4 MB** süreçler arası veri ve yaklaşık **58.765 iletişim turu** raporladı. Bu loopback üzerindeki üç teklifli deneydir; yaklaşık sekiz saniyelik yerel çalışma WAN gecikmesi veya bulut maliyeti tahmini değildir. Şu yapılandırma 64-bit SPDZ2k güvenlik ve 40-bit istatistiksel parametre kullanır; tüm sisteme 128-bit güvenlik veya "kırılamaz" etiketi verilmez. Gerçek dağıtım öncesi protokol/commitment performansı ve güvenlik hedefi yeniden ölçülmelidir.
- İlk fiyatlı seçim, dürüst maliyet açıklamasını teşvik eden bir mekanizma olduğu iddiasını taşımaz; stratejik fiyatlama, Sybil/kollüzyon ve roster qualification politikası ayrı değerlendirilir.
- Registry artık alıcı yetkisiyle v2 seçilmiş executor atar ve attempt hash'ine bağlar. Kontrat MPC sonucunun doğruluğunu kriptografik olarak ispatlamaz.
- Aynı host altındaki operatörler üretim mahremiyet ayrımı sağlamaz. Bağımsız işletmeciler, kimlik/cert dağıtımı ve key yönetimi gerekir.
- Buyer plaintext referans kontrolü satıcıya adil ödeme sağlamaz. Market hold/accept API, kanıt/uyuşmazlık ve timeout/refund mekanizması ayrıca doğrulanıp uygulanmalıdır.
- İspatlanmış veya attest edilmiş execution olmadan registry'deki kayıt yalnız yetkili executor'ın beyanıdır. Çıktıyı gören müşterinin ödemeyi reddetmesi çözülmüş değildir.
