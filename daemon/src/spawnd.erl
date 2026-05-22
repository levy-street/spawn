-module(spawnd).

-export([main/1]).

main(Args) ->
    spawnd_cli:main(Args).
