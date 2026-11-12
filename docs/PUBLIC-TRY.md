# Kurulumsuz canlı deneme

`/try`: dört 0–1.000.000 tam sayıyı tarayıcıda Paillier ile şifreler, `/api/private-sum` yalnız açık modül ve dört şifreli sayı alır, bunları n² modunda çarpar. Tarayıcı toplamı çözer ve kendi girdileriyle karşılaştırır. Her koşum yeni anahtar ve her şifreleme yeni rastgelelik kullanır. Anahtar/p/q sunucuya gönderilmez, kalıcı tarayıcı depolaması yoktur.

Bu yeni profil yalnız toplama yapar. Concrete veri temizleme devresi ve MPC/testnet ihalesi `/privacy` ve yerel istemci üzerinden ayrı sunulur. Bu sayfa o devrelerin tarayıcıya taşındığı iddiasında bulunmaz. Bağımsız denetim, yürütme ispatı, trafik gizliliği veya site işletmecisinin zararlı JS dağıtmasına karşı koruma yoktur. Sunucu sağlayıcısının IP/zamanlama erişimi mümkündür. Demo için örnek veri kullanılır.

Kaynak: Pascal Paillier, EUROCRYPT 1999, https://www.cs.tau.ac.il/~fiat/crypt07/papers/Pai99pai.pdf. Toplamsal özellik E(a)E(b) mod n² = E(a+b mod n). 2048-bit modül ve olasılıksal asal testleri kullanılan uygulama bir araştırma prototipidir.

Yerel gerçek tarayıcı kontrolü (12 Kasım 2026): 125/340/210/85 →760 (1,60s); yeni anahtarla 0/1000000/42/7 →1000049 (0,75s). Bunlar gerçek HTTP API çağrısı + tarayıcı çözümüdür; keygen dahil duvar saati ölçümleri örneğe/cihaza bağlıdır, performans garantisi değildir.
