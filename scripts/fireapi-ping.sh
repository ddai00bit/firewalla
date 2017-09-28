#!/bin/bash
# -----------------------------------------
# This is a watch dog function for fireapi.
# In case fireapi hangs, need to restart it.
# -----------------------------------------

TOTAL_RETRIES=5
SLEEP_TIMEOUT=10

IP_ADDRESS=$(ifconfig eth0|awk '/inet /{print $2}'| awk -F: '{print $2}')
FIREAPI_GID=$(redis-cli hget sys:ept gid)
FIREAPI_URL="http://${IP_ADDRESS}:8834/v1/encipher/message/$FIREAPI_GID"
FIREAPI_REQ=$'{
    "message": {
        "from": "Unamed",
        "obj" : {
            "mtype": "cmd",
            "id": "53D8D66E-02BC-44A7-B7C5-B7668FBCC4BA",
            "data": {
                "item": "ping"
            },
            "type": "jsonmsg",
            "target": "0.0.0.0"
        },
        "appInfo": {
            "appID": "com.rottiesoft.circle",
            "version": "1.18",
            "platform": "ios"
        },
        "msg": "",
        "type": "jsondata",
        "compressMode": 1,
        "mtype": "msg"
    },
    "mtype": "msg"
}'

fireapi_ping() {
    resp=$(curl -s $FIREAPI_URL \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        --data-binary "$FIREAPI_REQ" \
        --compressed)
   echo $resp | egrep -q '"code": *200'
}

retry=1
ping_ok=0
while (( $retry <= $TOTAL_RETRIES ))
do
    if fireapi_ping; then
        ping_ok=1
        break
    fi
    sleep $SLEEP_TIMEOUT
    (( retry++ ))
done

if [[ $ping_ok -ne 1 ]]; then
    logger "FireAPI ping FAILED, reboot now"
    sudo reboot now
fi


