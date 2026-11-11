// Test the actual patched MP-SPDZ TLS class; no duplicate certificate verifier.
#include "Networking/ssl_sockets.h"
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <iostream>

int main(int argc, char** argv)
{
    if (argc != 2) return 2;
    ssl_service service;
    ssl_ctx context("P0");
    unsigned char fingerprint[EVP_MAX_MD_SIZE];
    unsigned int fingerprint_size = 0;
    X509_digest(SSL_CTX_get0_certificate(context.native_handle()), EVP_sha256(),
                fingerprint, &fingerprint_size);
    std::cerr << "LOADED_P0_DER_SHA256=";
    for (unsigned int i = 0; i < fingerprint_size; ++i) {
        const char* digits = "0123456789abcdef";
        std::cerr << digits[fingerprint[i] >> 4] << digits[fingerprint[i] & 15];
    }
    std::cerr << std::endl;
    int listener = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) return 2;
    int reuse = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(std::stoi(argv[1]));
    if (::bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) ||
            ::listen(listener, 1)) return 2;
    std::cout << "READY" << std::endl;
    int accepted = ::accept(listener, nullptr, nullptr);
    ::close(listener);
    if (accepted < 0) return 2;
    try {
        ssl_socket peer(service, context, accepted, "C1", "P0", false);
        const char marker[] = "ACCEPTED";
        boost::asio::write(peer, boost::asio::buffer(marker, 8));
        std::cout << "ACCEPTED" << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "TLS_REJECTED " << error.what() << std::endl;
        return 3;
    }
}
