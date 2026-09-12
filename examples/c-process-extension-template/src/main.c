#include <stdio.h>
#include <string.h>

static void write_activate_response(void) {
    puts("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":true}");
    fflush(stdout);
}

static void write_deactivate_response(void) {
    puts("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":true}");
    fflush(stdout);
}

static void write_invoke_response(void) {
    puts("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"message\":\"hello from c process extension\"}}");
    fflush(stdout);
}

static void write_unknown_response(void) {
    puts("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"Unknown method or capability\"}}");
    fflush(stdout);
}

int main(void) {
    char line[4096];

    while (fgets(line, sizeof(line), stdin) != NULL) {
        if (strstr(line, "\"method\":\"extension/activate\"")) {
            write_activate_response();
            continue;
        }

        if (strstr(line, "\"method\":\"extension/deactivate\"")) {
            write_deactivate_response();
            break;
        }

        if (strstr(line, "\"method\":\"extension/invoke\"") && strstr(line, "\"capability\":\"demo.hello\"")) {
            write_invoke_response();
            continue;
        }

        write_unknown_response();
    }

    return 0;
}
