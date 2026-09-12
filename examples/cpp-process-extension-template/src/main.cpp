#include <iostream>
#include <string>

int main() {
    std::string line;

    while (std::getline(std::cin, line)) {
        if (line.find("\"method\":\"extension/activate\"") != std::string::npos) {
            std::cout << "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":true}" << std::endl;
            continue;
        }

        if (line.find("\"method\":\"extension/deactivate\"") != std::string::npos) {
            std::cout << "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":true}" << std::endl;
            break;
        }

        if (line.find("\"method\":\"extension/invoke\"") != std::string::npos &&
            line.find("\"capability\":\"demo.hello\"") != std::string::npos) {
            std::cout << "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"message\":\"hello from cpp process extension\"}}" << std::endl;
            continue;
        }

        std::cout << "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"Unknown method or capability\"}}" << std::endl;
    }

    return 0;
}
